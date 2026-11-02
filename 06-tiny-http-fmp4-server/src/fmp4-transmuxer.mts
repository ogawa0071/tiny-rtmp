import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import handle_rtmp_payload, { AACPacketType, AudioCodecType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import type { AudioData, VideoData } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import { write_mp4_aac_track_information } from './aac.mts';
import { fragment, initialize, make } from './fmp4.mts';
import { write_mp4_avc_track_information } from './avc.mts';

// 映像・音声のフレーム (初期化情報を除いたもの)
type Frame = Extract<VideoData, { packetType: typeof PacketType.CodedFrames; }> | Extract<AudioData, { packetType: typeof AACPacketType.Raw; }>;

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;
// onMetaData にコーデックが書かれていない時に、まだ初期化情報が届いていないトラックを、最初のフレームから待つ長さ (ミリ秒)
const UNDECLARED_TRACK_WAIT = 1000;
// 初期化情報を待っている間に取っておくフレームの数の上限 (1 秒間に届くフレームの数より十分に多くする)
// (キーフレームがなかなか届かない配信や timestamp が進まない配信では、keep で取っておくフレームが減らないので、取っておくフレームが増え続けないようにする)
const MAX_WAITING_FRAMES = 1000;

// 視聴者に送る fMP4 の断片 (moof + mdat)
export type FMP4Fragment = {
  data: Buffer;
  // ここから送り始めてもデコードできるか (映像のキーフレームか、映像のない配信の音声のフレーム)
  independent: boolean;
};

export default class FMP4Transmuxer {
  private timestamps = new TimestampUnwrapper();
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;
  // 最初に届いた映像のメッセージが、従来の形式の H.264 (AVC) か (Enhanced RTMP の HEVC などや Sorenson H.263 なら false: このサーバでは fMP4 にしない)
  private firstVideoIsAVC: boolean | null = null;
  // 最初に届いた音声のメッセージの SoundFormat (AudioTagHeader の先頭 4bit: 10 は AAC、2 は MP3、9 は Enhanced RTMP の形式)
  private firstAudioFormat: number | null = null;
  // 初期化情報より先に H.264 のフレームが届いたか (その映像は fMP4 にできないので、映像のトラックがない配信として扱う: feed)
  private videoSequenceHeaderMissing = false;
  // 最初に届いたフレームの timestamp (onMetaData にコーデックが書かれていない時に、UNDECLARED_TRACK_WAIT の間だけ届いていないトラックを待つ)
  private firstFrameTimestamp: number | null = null;
  // 初期化セグメントを作れるまでの間に届いたフレーム (初期化セグメントを作ってから fMP4 にする: keep)
  private waitingFrames: Frame[] = [];

  private initializeSegment: Buffer | null = null;
  // 初期化セグメントに入れたトラック (初期化セグメントを作る時に決めて、後から変えない)
  private hasVideo = false;
  private hasAudio = false;
  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;
  private sequenceNumber = 0; // mfhd の sequence_number (moof ごとに 1 から増やす)

  public initialize(): Buffer | null {
    return this.initializeSegment;
  }

  // 初期化セグメント (ftyp + moov) を作る (まだ作れなければ null)
  // frame: いま届いたフレーム
  private create_initialize_segment(frame: Frame): Buffer | null {
    // このサーバが fMP4 にするコーデック (H.264, AAC) のトラックは、初期化情報が届くまで待つ
    // 映像・音声は、もう届いていれば最初に届いたもののコーデックで、まだ届いていなければ onMetaData で決める
    // (コーデックを数値ではなく 'avc1' や 'mp4a' の文字列で送ってくる配信ソフトもある)
    // (onMetaData に AAC と書かれていても、最初に AAC 以外の音声が届いたなら AAC は届かないので待たない。
    //  onMetaData に書かれていなくても、最初に AAC が届いたなら待つ: 中身が空の初期化情報が先に届いても、本当の初期化情報は後から届く)
    // それ以外のコーデック (MP3 や Sorenson H.263 など) のトラックは待たない (このサーバでは fMP4 にしないので、そのトラックがない配信として扱う)
    // (初期化情報より先にフレームが届いた H.264 も fMP4 にできないので待たない: feed)
    const video_expected = (this.firstVideoIsAVC ?? (this.onMetadata?.videocodecid === VideoCodecType.AVC || this.onMetadata?.videocodecid === 'avc1')) && !this.videoSequenceHeaderMissing;
    const audio_expected = this.firstAudioFormat != null
      ? this.firstAudioFormat === AudioCodecType.AAC
      : (this.onMetadata?.audiocodecid === AudioCodecType.AAC || this.onMetadata?.audiocodecid === 'mp4a');
    if ((video_expected && this.avcDecoderConfigurationRecord == null) || (audio_expected && this.audioSpecificConfig == null)) {
      // 待っている間に届いたフレームも取っておく
      // (B フレームのある H.264 と ADTS の AAC (MPEG-TS や HLS の入力など) を FFmpeg が -c copy で送ると、本当の AAC の初期化情報が最初の映像のキーフレームより後に届く。
      //  捨てると最初のキーフレームがなくなり、視聴者は次のキーフレームまで見始められない)
      this.keep(frame);
      return null;
    }
    if (this.avcDecoderConfigurationRecord == null && this.audioSpecificConfig == null) { return null; }

    // onMetaData にコーデックが 1 つも書かれていない時 (onMetaData を送ってこない配信ソフトや、yasea など) は、どのトラックが届くか分からない
    // yasea などは、それぞれのトラックの初期化情報をそのトラックの最初のフレームの直前に送ってくるので、もう一方のトラックの初期化情報は最初のフレームより後に届く
    // そこで、まだ何も届いていないトラックを、最初のフレームから少しの間 (UNDECLARED_TRACK_WAIT) だけ待つ
    // (待っている間に届いたフレームは取っておく: 捨てると最初のキーフレームがなくなり、視聴者は次のキーフレームまで見始められない)
    const declared = this.onMetadata?.videocodecid != null || this.onMetadata?.audiocodecid != null;
    const missing = (this.avcDecoderConfigurationRecord == null && this.firstVideoIsAVC == null) || (this.audioSpecificConfig == null && this.firstAudioFormat == null);
    if (!declared && missing) {
      this.firstFrameTimestamp ??= frame.timestamp;
      if (frame.timestamp - this.firstFrameTimestamp < UNDECLARED_TRACK_WAIT) {
        this.keep(frame);
        return null;
      }
    }

    // 初期化セグメントには、それまでに初期化情報が届いたトラックを全て入れる
    // (onMetaData を送ってこない配信ソフトや、onMetaData にコーデックを書かない配信ソフト (yasea など) もあるので、onMetaData に書かれていなくても入れる)
    // (後から初期化情報が届いたトラックは、初期化セグメントにないので使えない)
    this.hasVideo = this.avcDecoderConfigurationRecord != null;
    this.hasAudio = this.audioSpecificConfig != null;
    const tracks = new Map<number, Buffer>();
    if (this.avcDecoderConfigurationRecord != null) {
      tracks.set(VIDEO_TRACK_ID, write_mp4_avc_track_information(VIDEO_TRACK_ID, RTMP_TIMESCALE, this.avcDecoderConfigurationRecord));
    }
    if (this.audioSpecificConfig != null) {
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      tracks.set(AUDIO_TRACK_ID, write_mp4_aac_track_information(AUDIO_TRACK_ID, samplingFrequency, this.audioSpecificConfig));
    }

    return make((vector) => {
      initialize(RTMP_TIMESCALE, [... tracks.keys()], vector, (vector) => {
        for (const track of tracks.values()) { vector.write(track); }
      });
    });
  }

  // 初期化セグメントを作れるまでの間に届いたフレームを取っておく
  // 初期化情報がいつまでも届かないこともあるので、取っておくのは最近の UNDECLARED_TRACK_WAIT の間に届いたフレームと、
  // 一番新しい映像のキーフレームから後のフレームだけ (多くても MAX_WAITING_FRAMES 個) にする
  // (GOP が UNDECLARED_TRACK_WAIT より長いと、最近のフレームにはキーフレームがないことがあり、それだけでは視聴者が見始められない)
  // (古い方から捨てるので、取っておいたフレームの途中に間は空かない)
  private keep(frame: Frame): void {
    this.waitingFrames.push(frame);
    const keyframe = this.waitingFrames.findLastIndex((kept) => kept.kind === 'Video' && kept.frameType === FrameType.KEY_FRAME);
    this.waitingFrames = this.waitingFrames.filter(({ timestamp }, index) => frame.timestamp - timestamp < UNDECLARED_TRACK_WAIT || (keyframe >= 0 && index >= keyframe)).slice(-MAX_WAITING_FRAMES);
  }

  // RTMP のメッセージを fMP4 の断片にする (初期化セグメントを作った時は、待っている間に取っておいたフレームの断片もまとめて返す)
  public feed(received: Message): FMP4Fragment[] {
    // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
    const message = this.timestamps.unwrap(received);
    // 映像と音声のコーデックは、最初に届いた映像と音声のメッセージで決める
    // (handle_rtmp_payload は H.264 以外の映像や AAC 以外の音声、中身が空の初期化情報には null を返すので、VideoTagHeader と AudioTagHeader の先頭を見る)
    // (映像は先頭 1bit が立っていれば Enhanced RTMP の形式で、そうでなければ下位 4bit が CodecID。音声は先頭 4bit が SoundFormat)
    // (AAC の配信でも、FFmpeg 8.0 以降は 5.1ch などの MultichannelConfig や 2 つ目の音声トラックを Enhanced RTMP の形式 (SoundFormat 9) で送ってくる。
    //  ADTS の AAC (MPEG-TS や HLS の入力など) を -c copy で送る時は、それが本当の AAC の初期化情報より先に届くが、その前に中身が空の AAC の初期化情報が届く)
    if (message.message_type_id === MessageType.Video && message.data.byteLength >= 1) {
      this.firstVideoIsAVC ??= (message.data[0] & 0x80) === 0 && (message.data[0] & 0x0F) === VideoCodecType.AVC;
    }
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return []; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          // 初期化情報より先にフレームが届いた映像は、映像のトラックがない配信として扱うので (下)、後から初期化情報が届いても使わない
          if (this.videoSequenceHeaderMissing) { return []; }
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return [];
        }
        // 初期化情報より先に映像のフレームが届いたら、その映像は fMP4 にできないので、映像のトラックがない配信として扱う (09 の HLSGenerator と同じ)
        // (FFmpeg 6.0 以前で初期化情報を出さないエンコーダの H.264 を送ると、中身が空の初期化情報しか届かない: 03 の handle_avc)
        if (this.avcDecoderConfigurationRecord == null && !this.videoSequenceHeaderMissing) {
          logger.warn('Video sequence header is missing, video is ignored', { codec: payload.codec });
          this.videoSequenceHeaderMissing = true;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return [];
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        // 初期化情報が届くまで待つトラック (create_initialize_segment) は、最初の onMetaData で決める (初期化セグメントを作る前に onMetaData が送り直されても変えない)
        if (metadata != null) { this.onMetadata ??= metadata; }
        return [];
      }
    }

    if (this.initializeSegment == null) {
      this.initializeSegment = this.create_initialize_segment(payload);
      if (this.initializeSegment == null) { return []; }
      // 待っている間に取っておいたフレームがあれば、いま届いたフレームより先に fMP4 にする
      const frames = [... this.waitingFrames, payload];
      this.waitingFrames = [];
      return frames.map((frame) => this.write(frame)).filter((fragment) => fragment != null);
    }

    const fragment = this.write(payload);
    return fragment == null ? [] : [fragment];
  }

  // フレームを fMP4 の断片にする (初期化セグメントにないトラックのフレームや、映像の最初のフレームなら null)
  private write(payload: Frame): FMP4Fragment | null {
    switch (payload.kind) {
      case 'Video': {
        if (!this.hasVideo) { return null; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        const previous = this.previousVideoInformation;
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        if (previous == null) { return null; }

        const { type, dts, cto, data } = previous;
        const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
        const keyframe = type === FrameType.KEY_FRAME;
        return {
          data: make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: VIDEO_TRACK_ID, keyframe, duration, dts, cto }, data, vector);
          }),
          independent: keyframe,
        };
      }
      case 'Audio': {
        if (!this.hasAudio) { return null; }
        // AAC は 1 フレームが 1024 サンプルなので、前のフレームから 1024 ずつ進める
        // ただし、音声が途切れるなどで RTMP の timestamp と 1 フレーム以上ずれたら、RTMP の timestamp に合わせ直す
        const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig!);
        const timestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        if (this.aacLatestTimestamp == null || Math.abs(this.aacLatestTimestamp + 1024 - timestamp) > 1024) {
          this.aacLatestTimestamp = timestamp;
        } else {
          this.aacLatestTimestamp += 1024;
        }
        const dts = this.aacLatestTimestamp;
        return {
          data: make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: AUDIO_TRACK_ID, keyframe: true, duration: 1024, dts, cto: 0 }, payload.data, vector);
          }),
          // 映像がある時は、映像のキーフレームから送り始める
          independent: !this.hasVideo,
        };
      }
    }
  }
}

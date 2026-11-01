import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import handle_rtmp_payload, { AACPacketType, AudioCodecType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import { write_mp4_aac_track_information } from './aac.mts';
import { fragment, initialize, make } from './fmp4.mts';
import { write_mp4_avc_track_information } from './avc.mts';

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
  // 最初に届いた音声のメッセージの SoundFormat (AudioTagHeader の先頭 4bit: 10 は AAC、2 は MP3、9 は Enhanced RTMP の形式)
  private firstAudioFormat: number | null = null;
  // 最初に届いたフレームの timestamp (onMetaData にコーデックが書かれていない時に、UNDECLARED_TRACK_WAIT の間だけ届いていないトラックを待つ)
  private firstFrameTimestamp: number | null = null;

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
  // timestamp: いま届いたフレームの timestamp
  private create_initialize_segment(timestamp: number): Buffer | null {
    // このサーバが fMP4 にするコーデック (H.264, AAC) のトラックは、初期化情報が届くまで待つ
    // 映像は、onMetaData に H.264 と書かれていれば待つ (コーデックを数値ではなく 'avc1' や 'mp4a' の文字列で送ってくる配信ソフトもある)
    // 音声は、もう届いていれば最初に届いた音声のコーデックで、まだ届いていなければ onMetaData で決める
    // (onMetaData に AAC と書かれていても、最初に AAC 以外の音声が届いたなら AAC は届かないので待たない。
    //  onMetaData に書かれていなくても、最初に AAC が届いたなら待つ: 中身が空の初期化情報が先に届いても、本当の初期化情報は後から届く)
    // それ以外のコーデック (MP3 や Sorenson H.263 など) のトラックは待たない (このサーバでは fMP4 にしないので、そのトラックがない配信として扱う)
    const video_expected = this.onMetadata?.videocodecid === VideoCodecType.AVC || this.onMetadata?.videocodecid === 'avc1';
    const audio_expected = this.firstAudioFormat != null
      ? this.firstAudioFormat === AudioCodecType.AAC
      : (this.onMetadata?.audiocodecid === AudioCodecType.AAC || this.onMetadata?.audiocodecid === 'mp4a');
    if (video_expected && this.avcDecoderConfigurationRecord == null) { return null; }
    if (audio_expected && this.audioSpecificConfig == null) { return null; }
    if (this.avcDecoderConfigurationRecord == null && this.audioSpecificConfig == null) { return null; }

    // onMetaData にコーデックが 1 つも書かれていない時 (onMetaData を送ってこない配信ソフトや、yasea など) は、どのトラックが届くか分からない
    // yasea などは、それぞれのトラックの初期化情報をそのトラックの最初のフレームの直前に送ってくるので、もう一方のトラックの初期化情報は最初のフレームより後に届く
    // そこで、まだ初期化情報が届いていないトラックを、最初のフレームから少しの間 (UNDECLARED_TRACK_WAIT) だけ待つ (待っている間に届いたフレームは捨てる)
    const declared = this.onMetadata?.videocodecid != null || this.onMetadata?.audiocodecid != null;
    const missing = this.avcDecoderConfigurationRecord == null || (this.audioSpecificConfig == null && this.firstAudioFormat == null);
    if (!declared && missing) {
      this.firstFrameTimestamp ??= timestamp;
      if (timestamp - this.firstFrameTimestamp < UNDECLARED_TRACK_WAIT) { return null; }
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

  public feed(received: Message): FMP4Fragment | null {
    // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
    const message = this.timestamps.unwrap(received);
    // 音声のコーデックは、最初に届いた音声のメッセージで決める
    // (handle_rtmp_payload は AAC 以外の音声や中身が空の AAC の初期化情報には null を返すので、AudioTagHeader の先頭 4bit の SoundFormat を見る)
    // (AAC の配信でも、FFmpeg 8.0 以降は 5.1ch などの MultichannelConfig や 2 つ目の音声トラックを Enhanced RTMP の形式 (SoundFormat 9) で送ってくる。
    //  ADTS の AAC (MPEG-TS や HLS の入力など) を -c copy で送る時は、それが本当の AAC の初期化情報より先に届くが、その前に中身が空の AAC の初期化情報が届く)
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return null; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return null;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return null;
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        // 初期化情報が届くまで待つトラック (create_initialize_segment) は、最初の onMetaData で決める (初期化セグメントを作る前に onMetaData が送り直されても変えない)
        if (metadata != null) { this.onMetadata ??= metadata; }
        return null;
      }
    }

    this.initializeSegment ??= this.create_initialize_segment(payload.timestamp);
    if (this.initializeSegment == null) { return null; }

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

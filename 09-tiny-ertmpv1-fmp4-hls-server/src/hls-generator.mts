import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { AACPacketType, AudioCodecType, read_onmetadata, TimestampUnwrapper, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import { fragment, initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';
import { write_mp4_avc_track_information } from '../../06-tiny-http-fmp4-server/src/avc.mts';
import { write_mp4_aac_track_information } from '../../06-tiny-http-fmp4-server/src/aac.mts';

import handle_rtmp_payload, { FrameType, PacketType } from './rtmp-handler.mts';
import type { AudioData, VideoData } from './rtmp-handler.mts';
import { read_nal_unit_length_size, strip_parameter_sets, write_mp4_hevc_track_information } from './hevc.mts';
import MediaPlaylist from './media-playlist.mts';

// 映像・音声のフレーム (初期化情報や、対応していないコーデックのものを除いたもの)
type Frame = Extract<VideoData, { packetType: typeof PacketType.CodedFrames; }> | Extract<AudioData, { packetType: typeof AACPacketType.Raw; }>;

type VideoInformation = {
  frameType: number;
  dts: number;
  cto: number;
  data: Buffer;
};

type AudioInformation = {
  dts: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;
// Enhanced RTMP の onMetaData の videocodecid は、FourCC を big endian の 32bit 整数にした値 ('hvc1' なら 0x68766331)
const HEVC_FOURCC = Buffer.from('hvc1', 'ascii').readUInt32BE(0);
// onMetaData にコーデックが書かれていない時に、まだ初期化情報が届いていないトラックを、最初のフレームから待つ長さ (ミリ秒)
const UNDECLARED_TRACK_WAIT = 1000;

export default class HLSGenerator {
  private timestamps = new TimestampUnwrapper();
  private videoTrack: Buffer | null = null;
  private audioTrack: Buffer | null = null;
  // HEVC の映像データの NAL Unit の前に付いている長さのバイト数 (HEVCDecoderConfigurationRecord で決まる)
  private hevcNalUnitLengthSize = 4;
  // 初期化セグメントに入れたトラック (初期化セグメントを作る時に決めて、後から変えない)
  private hasVideo = false;
  private hasAudio = false;

  private previousVideoInformation: VideoInformation | null = null;
  private previousAudioInformation: AudioInformation | null = null;

  private onMetadata: AMF0Object | null = null;
  // 映像・音声が対応していないコーデック (AV1 や MP3 など) や、初期化情報が届かずに使えないコーデックなら、そのコーデック (そのトラックがない配信として扱う)
  private unsupportedVideoCodec: string | number | null = null;
  private unsupportedAudioCodec: number | null = null;
  // 最初に届いた音声のメッセージの SoundFormat (AudioTagHeader の先頭 4bit: 10 は AAC、2 は MP3、9 は Enhanced RTMP の形式)
  private firstAudioFormat: number | null = null;
  // 最初に届いたフレームの timestamp (onMetaData にコーデックが書かれていない時に、UNDECLARED_TRACK_WAIT の間だけ届いていないトラックを待つ)
  private firstFrameTimestamp: number | null = null;
  // UNDECLARED_TRACK_WAIT の間に届いたフレーム (初期化セグメントを作ってから書き出す)
  private waitingFrames: Frame[] = [];
  private sequenceNumber = 0; // mfhd の sequence_number (moof ごとに 1 から増やす)

  private initialization: Buffer | null = null;
  private playlist: MediaPlaylist;

  public constructor(liveWindowLength: number = 3) {
    this.playlist = new MediaPlaylist({ liveWindowLength });
  }

  public published(): Promise<boolean> {
    return this.playlist.published;
  }

  public segment(msn: number): Buffer | null {
    return this.playlist.segment(msn);
  }

  public initialize(): Buffer | null {
    return this.initialization;
  }

  public m3u8(): string {
    return this.playlist.m3u8();
  }

  public end(): void {
    // 最後のフレームは長さが分からないので書き出せていない
    // 最後に書き出したフレームの終わり (= 最後のフレームの先頭) までで、最後のセグメントを完成させる
    const last = this.previousVideoInformation ?? this.previousAudioInformation;
    this.playlist.end(last == null ? null : PlaylistTimestamp.fromRTMP(last.dts));
  }

  public feed(received: Message): void {
    // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
    const message = this.timestamps.unwrap(received);
    // 音声のコーデックは、最初に届いた音声のメッセージで決める
    // (中身が空の AAC の初期化情報は handle_rtmp_payload では null になるので、AudioTagHeader の先頭 4bit の SoundFormat を見る)
    // (ADTS の AAC (MPEG-TS や HLS の入力など) を -c copy で送る時は、中身が空の AAC の初期化情報が最初に届き、本当の初期化情報は後から届く)
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    // 対応していないコーデックの映像・音声はこのサーバでは fMP4 にしないので、そのトラックがない配信として扱う
    if (payload.kind === 'Video' && payload.codec === 'Unsupported') {
      if (this.unsupportedVideoCodec == null) { logger.warn('Unsupported video codec, video is ignored', { codecId: payload.codecId }); }
      this.unsupportedVideoCodec = payload.codecId;
      return;
    }
    if (payload.kind === 'Audio' && payload.codec === 'Unsupported') {
      // 最初に届いた音声が AAC なら、その後に届く AAC 以外の音声は読み飛ばすだけで、AAC のトラックはやめない
      // (FFmpeg 8.0 以降は、5.1ch などの MultichannelConfig や 2 つ目の音声トラックを Enhanced RTMP の形式 (SoundFormat 9) で送ってくる。
      //  ADTS の AAC を -c copy で送る時は、それが本当の AAC の初期化情報より先に届く)
      if (this.firstAudioFormat === AudioCodecType.AAC) { return; }
      if (this.unsupportedAudioCodec == null) { logger.warn('Unsupported audio codec, audio is ignored', { soundFormat: payload.soundFormat }); }
      this.unsupportedAudioCodec = payload.soundFormat;
      return;
    }
    // 初期化情報より先に映像のフレームが届いたら、その映像は fMP4 にできないので、映像のトラックがない配信として扱う
    // (FFmpeg 6.1 で初期化情報を出さないエンコーダの HEVC を送ると、中身が空の初期化情報しか届かない: rtmp-handler の handle_hevc)
    if (payload.kind === 'Video' && payload.packetType !== PacketType.SequenceStart && this.videoTrack == null && this.unsupportedVideoCodec == null) {
      logger.warn('Video sequence header is missing, video is ignored', { codec: payload.codec });
      this.unsupportedVideoCodec = payload.codec;
      return;
    }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType !== PacketType.SequenceStart) { break; }
        switch (payload.codec) {
          case 'AVC':
            this.videoTrack = write_mp4_avc_track_information(VIDEO_TRACK_ID, RTMP_TIMESCALE, payload.avcDecoderConfigurationRecord);
            break;
          case 'HEVC':
            this.videoTrack = write_mp4_hevc_track_information(VIDEO_TRACK_ID, RTMP_TIMESCALE, payload.hevcDecoderConfigurationRecord);
            this.hevcNalUnitLengthSize = read_nal_unit_length_size(payload.hevcDecoderConfigurationRecord);
            break;
        }
        return;
      case 'Audio':
        if (payload.packetType !== AACPacketType.SequenceHeader) { break; }
        this.audioTrack = write_mp4_aac_track_information(AUDIO_TRACK_ID, RTMP_TIMESCALE, payload.audioSpecificConfig);
        return;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        // 初期化情報が届くまで待つトラックは、最初の onMetaData で決める (曲名だけを書いた onMetaData などが送り直されても変えない)
        if (metadata != null) { this.onMetadata ??= metadata; }
        return;
      }
    }

    // このサーバが fMP4 にするコーデック (H.264, H.265, AAC) のトラックは、初期化情報が揃うまで何もしない
    // 映像は、onMetaData に H.264 か H.265 と書かれていれば待つ (コーデックを数値ではなく 'avc1' などの文字列で送ってくる配信ソフトもある)
    // 音声は、もう届いていれば最初に届いた音声のコーデックで、まだ届いていなければ onMetaData で決める
    // (onMetaData に AAC と書かれていても、最初に AAC 以外の音声が届いたなら AAC は届かないので待たない。
    //  onMetaData に書かれていなくても、最初に AAC が届いたなら待つ: 中身が空の初期化情報が先に届いても、本当の初期化情報は後から届く)
    // このサーバが fMP4 にしないコーデック (MP3 や Sorenson H.263 など) のトラックは待たない
    // (MP3 も 'mp4a' の esds の ObjectTypeIndication を 0x6B (MPEG-1 Audio) か 0x69 (MPEG-2 Audio) にすれば MP4 に入れられるが、このサーバでは扱わない。Sorenson H.263 は MP4 に入れる方法がない)
    // (MP3 などには初期化情報がなく、最初のフレームが届くまで対応していないと分からないので、待つとそれまでに届いた映像・音声が捨てられる)
    if (this.initialization == null) {
      const videocodecid = this.onMetadata?.videocodecid;
      const audiocodecid = this.onMetadata?.audiocodecid;
      const video_expected = videocodecid === VideoCodecType.AVC || videocodecid === HEVC_FOURCC || videocodecid === 'avc1' || videocodecid === 'hvc1';
      const audio_expected = this.firstAudioFormat != null
        ? this.firstAudioFormat === AudioCodecType.AAC
        : (audiocodecid === AudioCodecType.AAC || audiocodecid === 'mp4a');
      if ((video_expected && this.videoTrack == null && this.unsupportedVideoCodec == null) || (audio_expected && this.audioTrack == null)) {
        // 待っている間に届いたフレームは捨てる
        // (下の UNDECLARED_TRACK_WAIT の間に取っておいたフレームがあれば、それも捨てる。取っておいたフレームを書き出すと、捨てたフレームの分だけ間が空く)
        this.waitingFrames = [];
        return;
      }
      if (this.videoTrack == null && this.audioTrack == null) { return; }
      // onMetaData にコーデックが 1 つも書かれていない時 (onMetaData を送ってこない配信ソフトや、yasea など) は、どのトラックが届くか分からない
      // yasea などは、それぞれのトラックの初期化情報をそのトラックの最初のフレームの直前に送ってくるので、もう一方のトラックの初期化情報は最初のフレームより後に届く
      // そこで、まだ何も届いていないトラックを、最初のフレームから少しの間 (UNDECLARED_TRACK_WAIT) だけ待つ
      // (待っている間に届いたフレームは取っておく: 捨てると最初のキーフレームがなくなり、次のキーフレームまでの映像がセグメントにならない)
      const declared = videocodecid != null || audiocodecid != null;
      const missing = (this.videoTrack == null && this.unsupportedVideoCodec == null) || (this.audioTrack == null && this.firstAudioFormat == null);
      if (!declared && missing) {
        this.firstFrameTimestamp ??= payload.timestamp;
        if (payload.timestamp - this.firstFrameTimestamp < UNDECLARED_TRACK_WAIT) {
          this.waitingFrames.push(payload);
          return;
        }
      }

      // 初期化セグメントに入れたトラックだけを書き出す (後から初期化情報が届いたトラックは、初期化セグメントにないので使えない)
      this.hasVideo = this.videoTrack != null;
      this.hasAudio = this.audioTrack != null;
      this.initialization = make((vector) => {
        initialize(RTMP_TIMESCALE, [... (this.hasVideo ? [VIDEO_TRACK_ID] : []), ... (this.hasAudio ? [AUDIO_TRACK_ID] : [])], vector, (vector) => {
          if (this.videoTrack != null) { vector.write(this.videoTrack); }
          if (this.audioTrack != null) { vector.write(this.audioTrack); }
        });
      });
    }

    // 待っている間に取っておいたフレームがあれば、いま届いたフレームより先に書き出す
    for (const frame of this.waitingFrames) { this.write(frame); }
    this.waitingFrames = [];
    this.write(payload);
  }

  // フレームを fMP4 にしてセグメントに書き出す (初期化セグメントにないトラックのフレームは書き出さない)
  private write(payload: Frame): void {
    switch (payload.kind) {
      case 'Video': {
        if (!this.hasVideo) { return; }
        // hvc1 では VPS/SPS/PPS は hvcC だけに入れるので、映像データの中に送られてきたものは取り除く
        // (VPS/SPS/PPS だけを別のメッセージで送ってくる配信ソフトもあり、その時は何も残らない。長さ 0 のサンプルは読めないプレイヤーがあるので、フレームとして扱わない)
        const sample = payload.codec === 'HEVC' ? strip_parameter_sets(payload.data, this.hevcNalUnitLengthSize) : payload.data;
        if (sample.byteLength === 0) { return; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        if (this.previousVideoInformation != null) {
          const { frameType: type, dts, cto, data } = this.previousVideoInformation;
          const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
          this.playlist.feed(make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: VIDEO_TRACK_ID, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto }, data, vector);
          }));
        }
        // 1 つ前のフレームを今のセグメントに書き出してから、キーフレームで新しいセグメントを始める
        if (payload.frameType === FrameType.KEY_FRAME) {
          this.playlist.append(PlaylistTimestamp.fromRTMP(payload.timestamp));
        }
        this.previousVideoInformation = {
          frameType: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: sample,
        };
        return;
      }
      case 'Audio':
        if (!this.hasAudio) { return; }
        // FIXME: これは手抜き 各音声コーデックで sample 数から duration を厳密に求めるべき
        if (this.previousAudioInformation != null) {
          const { dts, data } = this.previousAudioInformation;
          const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
          this.playlist.feed(make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: AUDIO_TRACK_ID, keyframe: true, duration, dts, cto: 0 }, data, vector);
          }));
        }
        // 映像がある時は映像のキーフレームで区切るので、音声だけの時に限って音声で新しいセグメントを始める
        if (!this.hasVideo) {
          this.playlist.append(PlaylistTimestamp.fromRTMP(payload.timestamp));
        }
        this.previousAudioInformation = {
          dts: payload.timestamp,
          data: payload.data,
        };
        return;
    }
  }
}

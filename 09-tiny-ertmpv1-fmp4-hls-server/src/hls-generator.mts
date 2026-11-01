import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { AACPacketType, AudioCodecType, read_onmetadata, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import { fragment, initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';
import { write_mp4_avc_track_information } from '../../06-tiny-http-fmp4-server/src/avc.mts';
import { write_mp4_aac_track_information } from '../../06-tiny-http-fmp4-server/src/aac.mts';

import handle_rtmp_payload, { FrameType, PacketType } from './rtmp-handler.mts';
import { read_nal_unit_length_size, strip_parameter_sets, write_mp4_hevc_track_information } from './hevc.mts';
import MediaPlaylist from './media-playlist.mts';

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

export default class HLSGenerator {
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
  // 映像・音声が対応していないコーデック (AV1 や MP3 など) なら、そのコーデック (そのトラックがない配信として扱う)
  private unsupportedVideoCodec: string | number | null = null;
  private unsupportedAudioCodec: number | null = null;
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

  public feed(message: Message): void {
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    // 対応していないコーデックの映像・音声はこのサーバでは fMP4 にしないので、そのトラックがない配信として扱う
    if (payload.kind === 'Video' && payload.codec === 'Unsupported') {
      if (this.unsupportedVideoCodec == null) { logger.warn('Unsupported video codec, video is ignored', { codecId: payload.codecId }); }
      this.unsupportedVideoCodec = payload.codecId;
      return;
    }
    if (payload.kind === 'Audio' && payload.codec === 'Unsupported') {
      // AAC の初期化情報の後に届く AAC 以外の音声は読み飛ばすだけで、AAC のトラックはやめない
      // (FFmpeg 8.0 以降が 5.1ch などの AAC の初期化情報の後に送る MultichannelConfig や、2 つ目の音声トラックは、Enhanced RTMP の形式 (SoundFormat 9) で届く)
      if (this.audioTrack != null) { return; }
      if (this.unsupportedAudioCodec == null) { logger.warn('Unsupported audio codec, audio is ignored', { soundFormat: payload.soundFormat }); }
      this.unsupportedAudioCodec = payload.soundFormat;
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
        if (metadata != null) { this.onMetadata = metadata; }
        return;
      }
    }

    // onMetaData に書かれているトラックのうち、このサーバが fMP4 にするコーデック (H.264, H.265, AAC) のトラックの初期化情報が揃うまでは何もしない
    // このサーバが fMP4 にしないコーデック (MP3 や Sorenson H.263 など) のトラックは待たない
    // (MP3 も 'mp4a' の esds の ObjectTypeIndication を 0x6B (MPEG-1 Audio) か 0x69 (MPEG-2 Audio) にすれば MP4 に入れられるが、このサーバでは扱わない。Sorenson H.263 は MP4 に入れる方法がない)
    // (MP3 などには初期化情報がなく、最初のフレームが届くまで対応していないと分からないので、待つとそれまでに届いた映像・音声が捨てられる)
    // (onMetaData を送ってこない配信ソフトや、onMetaData にコーデックを書かない配信ソフト (yasea など) もあるので、その時は何も待たない)
    if (this.initialization == null) {
      // (コーデックを数値ではなく 'avc1' などの文字列で送ってくる配信ソフトもある)
      const videocodecid = this.onMetadata?.videocodecid;
      const audiocodecid = this.onMetadata?.audiocodecid;
      const video_expected = videocodecid === VideoCodecType.AVC || videocodecid === HEVC_FOURCC || videocodecid === 'avc1' || videocodecid === 'hvc1';
      const audio_expected = audiocodecid === AudioCodecType.AAC || audiocodecid === 'mp4a';
      if (video_expected && this.videoTrack == null && this.unsupportedVideoCodec == null) { return; }
      if (audio_expected && this.audioTrack == null && this.unsupportedAudioCodec == null) { return; }
      if (this.videoTrack == null && this.audioTrack == null) { return; }

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

import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { AACPacketType, read_onmetadata } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import { PlaylistTimestamp } from '../../04-tiny-hls-server/src/playlist-timestamp.mts';

import { fragment, initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';
import { write_mp4_avc_track_information } from '../../06-tiny-http-fmp4-server/src/avc.mts';
import { write_mp4_aac_track_information } from '../../06-tiny-http-fmp4-server/src/aac.mts';

import handle_rtmp_payload, { FrameType, PacketType } from './rtmp-handler.mts';
import { write_mp4_hevc_track_information } from './hevc.mts';
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

export default class HLSGenerator {
  private videoTrack: Buffer | null = null;
  private audioTrack: Buffer | null = null;

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

    // 対応していないコーデックの映像・音声は fMP4 にできないので、そのトラックがない配信として扱う
    if (payload.kind === 'Video' && payload.codec === 'Unsupported') {
      if (this.unsupportedVideoCodec == null) { logger.warn('Unsupported video codec, video is ignored', { codecId: payload.codecId }); }
      this.unsupportedVideoCodec = payload.codecId;
      return;
    }
    if (payload.kind === 'Audio' && payload.codec === 'Unsupported') {
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

    // onMetaData に書かれている全てのトラックの初期化情報が揃うまでは何もしない
    if (this.onMetadata == null) { return; }
    const has_video = this.videoTrack != null;
    const has_audio = this.audioTrack != null;
    if (this.onMetadata.videocodecid != null && !has_video && this.unsupportedVideoCodec == null) { return; }
    if (this.onMetadata.audiocodecid != null && !has_audio && this.unsupportedAudioCodec == null) { return; }

    this.initialization ??= make((vector) => {
      initialize(RTMP_TIMESCALE, [... (has_video ? [VIDEO_TRACK_ID] : []), ... (has_audio ? [AUDIO_TRACK_ID] : [])], vector, (vector) => {
        if (this.videoTrack != null) { vector.write(this.videoTrack); }
        if (this.audioTrack != null) { vector.write(this.audioTrack); }
      });
    });

    switch (payload.kind) {
      case 'Video':
        if (!has_video) { return; }
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
          data: payload.data,
        };
        return;
      case 'Audio':
        if (!has_audio) { return; }
        // FIXME: これは手抜き 各音声コーデックで sample 数から duration を厳密に求めるべき
        if (this.previousAudioInformation != null) {
          const { dts, data } = this.previousAudioInformation;
          const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
          this.playlist.feed(make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: AUDIO_TRACK_ID, keyframe: true, duration, dts, cto: 0 }, data, vector);
          }));
        }
        // 映像がある時は映像のキーフレームで区切るので、音声だけの時に限って音声で新しいセグメントを始める
        if (!has_video) {
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

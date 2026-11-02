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
const HEVC_FOURCC = Buffer.from('hvc1', 'ascii').readUInt32BE(0);
const UNDECLARED_TRACK_WAIT = 1000;
const MAX_WAITING_FRAMES = 1000;

export default class HLSGenerator {
  private timestamps = new TimestampUnwrapper();
  private videoTrack: Buffer | null = null;
  private audioTrack: Buffer | null = null;
  private hevcNalUnitLengthSize = 4;
  private hasVideo = false;
  private hasAudio = false;

  private previousVideoInformation: VideoInformation | null = null;
  private previousAudioInformation: AudioInformation | null = null;

  private onMetadata: AMF0Object | null = null;
  private unsupportedVideoCodec: string | number | null = null;
  private unsupportedAudioCodec: number | null = null;
  private firstAudioFormat: number | null = null;
  private firstFrameTimestamp: number | null = null;
  private waitingFrames: Frame[] = [];
  private sequenceNumber = 0;

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
    const last = this.previousVideoInformation ?? this.previousAudioInformation;
    this.playlist.end(last == null ? null : PlaylistTimestamp.fromRTMP(last.dts));
  }

  public feed(received: Message): void {
    const message = this.timestamps.unwrap(received);
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    if (payload.kind === 'Video' && payload.codec === 'Unsupported') {
      if (this.unsupportedVideoCodec == null) { logger.warn('Unsupported video codec, video is ignored', { codecId: payload.codecId }); }
      this.unsupportedVideoCodec = payload.codecId;
      return;
    }
    if (payload.kind === 'Audio' && payload.codec === 'Unsupported') {
      if (this.firstAudioFormat === AudioCodecType.AAC) { return; }
      if (this.unsupportedAudioCodec == null) { logger.warn('Unsupported audio codec, audio is ignored', { soundFormat: payload.soundFormat }); }
      this.unsupportedAudioCodec = payload.soundFormat;
      return;
    }
    if (payload.kind === 'Video' && payload.packetType !== PacketType.SequenceStart && this.videoTrack == null && this.unsupportedVideoCodec == null) {
      logger.warn('Video sequence header is missing, video is ignored', { codec: payload.codec });
      this.unsupportedVideoCodec = payload.codec;
      return;
    }

    switch (payload.kind) {
      case 'Video':
        if (payload.packetType !== PacketType.SequenceStart) { break; }
        if (this.videoTrack == null && this.unsupportedVideoCodec != null) { return; }
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
        if (metadata != null) { this.onMetadata ??= metadata; }
        return;
      }
    }

    if (this.initialization == null) {
      const videocodecid = this.onMetadata?.videocodecid;
      const audiocodecid = this.onMetadata?.audiocodecid;
      const video_expected = videocodecid === VideoCodecType.AVC || videocodecid === HEVC_FOURCC || videocodecid === 'avc1' || videocodecid === 'hvc1';
      const audio_expected = this.firstAudioFormat != null
        ? this.firstAudioFormat === AudioCodecType.AAC
        : (audiocodecid === AudioCodecType.AAC || audiocodecid === 'mp4a');
      if ((video_expected && this.videoTrack == null && this.unsupportedVideoCodec == null) || (audio_expected && this.audioTrack == null)) {
        this.keep(payload);
        return;
      }
      if (this.videoTrack == null && this.audioTrack == null) { return; }
      const declared = videocodecid != null || audiocodecid != null;
      const missing = (this.videoTrack == null && this.unsupportedVideoCodec == null) || (this.audioTrack == null && this.firstAudioFormat == null);
      if (!declared && missing) {
        this.firstFrameTimestamp ??= payload.timestamp;
        if (payload.timestamp - this.firstFrameTimestamp < UNDECLARED_TRACK_WAIT) {
          this.keep(payload);
          return;
        }
      }

      this.hasVideo = this.videoTrack != null;
      this.hasAudio = this.audioTrack != null;
      this.initialization = make((vector) => {
        initialize(RTMP_TIMESCALE, [... (this.hasVideo ? [VIDEO_TRACK_ID] : []), ... (this.hasAudio ? [AUDIO_TRACK_ID] : [])], vector, (vector) => {
          if (this.videoTrack != null) { vector.write(this.videoTrack); }
          if (this.audioTrack != null) { vector.write(this.audioTrack); }
        });
      });
    }

    for (const frame of this.waitingFrames) { this.write(frame); }
    this.waitingFrames = [];
    this.write(payload);
  }

  private keep(payload: Frame): void {
    this.waitingFrames.push(payload);
    const keyframe = this.waitingFrames.findLastIndex((kept) => kept.kind === 'Video' && kept.frameType === FrameType.KEY_FRAME);
    this.waitingFrames = this.waitingFrames.filter(({ timestamp }, index) => payload.timestamp - timestamp < UNDECLARED_TRACK_WAIT || (keyframe >= 0 && index >= keyframe)).slice(-MAX_WAITING_FRAMES);
  }

  private write(payload: Frame): void {
    switch (payload.kind) {
      case 'Video': {
        if (!this.hasVideo) { return; }
        const sample = payload.codec === 'HEVC' ? strip_parameter_sets(payload.data, this.hevcNalUnitLengthSize) : payload.data;
        if (sample.byteLength === 0) { return; }
        if (this.previousVideoInformation != null) {
          const { frameType: type, dts, cto, data } = this.previousVideoInformation;
          const duration = Math.max(0, payload.timestamp - dts);
          this.playlist.feed(make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: VIDEO_TRACK_ID, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto }, data, vector);
          }));
        }
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
          const duration = Math.max(0, payload.timestamp - dts);
          this.playlist.feed(make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: AUDIO_TRACK_ID, keyframe: true, duration, dts, cto: 0 }, data, vector);
          }));
        }
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

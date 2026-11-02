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
const UNDECLARED_TRACK_WAIT = 1000;
const MAX_WAITING_FRAMES = 1000;

export type FMP4Fragment = {
  data: Buffer;
  independent: boolean;
};

export default class FMP4Transmuxer {
  private timestamps = new TimestampUnwrapper();
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;
  private firstVideoIsAVC: boolean | null = null;
  private firstAudioFormat: number | null = null;
  private videoSequenceHeaderMissing = false;
  private firstFrameTimestamp: number | null = null;
  private waitingFrames: Frame[] = [];

  private initializeSegment: Buffer | null = null;
  private hasVideo = false;
  private hasAudio = false;
  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;
  private sequenceNumber = 0;

  public initialize(): Buffer | null {
    return this.initializeSegment;
  }

  private create_initialize_segment(frame: Frame): Buffer | null {
    const video_expected = (this.firstVideoIsAVC ?? (this.onMetadata?.videocodecid === VideoCodecType.AVC || this.onMetadata?.videocodecid === 'avc1')) && !this.videoSequenceHeaderMissing;
    const audio_expected = this.firstAudioFormat != null
      ? this.firstAudioFormat === AudioCodecType.AAC
      : (this.onMetadata?.audiocodecid === AudioCodecType.AAC || this.onMetadata?.audiocodecid === 'mp4a');
    if ((video_expected && this.avcDecoderConfigurationRecord == null) || (audio_expected && this.audioSpecificConfig == null)) {
      this.keep(frame);
      return null;
    }
    if (this.avcDecoderConfigurationRecord == null && this.audioSpecificConfig == null) { return null; }

    const declared = this.onMetadata?.videocodecid != null || this.onMetadata?.audiocodecid != null;
    const missing = (this.avcDecoderConfigurationRecord == null && this.firstVideoIsAVC == null) || (this.audioSpecificConfig == null && this.firstAudioFormat == null);
    if (!declared && missing) {
      this.firstFrameTimestamp ??= frame.timestamp;
      if (frame.timestamp - this.firstFrameTimestamp < UNDECLARED_TRACK_WAIT) {
        this.keep(frame);
        return null;
      }
    }

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

  private keep(frame: Frame): void {
    this.waitingFrames.push(frame);
    const keyframe = this.waitingFrames.findLastIndex((kept) => kept.kind === 'Video' && kept.frameType === FrameType.KEY_FRAME);
    this.waitingFrames = this.waitingFrames.filter(({ timestamp }, index) => frame.timestamp - timestamp < UNDECLARED_TRACK_WAIT || (keyframe >= 0 && index >= keyframe)).slice(-MAX_WAITING_FRAMES);
  }

  public feed(received: Message): FMP4Fragment[] {
    const message = this.timestamps.unwrap(received);
    if (message.message_type_id === MessageType.Video && message.data.byteLength >= 1) {
      this.firstVideoIsAVC ??= (message.data[0] & 0x80) === 0 && (message.data[0] & 0x0F) === VideoCodecType.AVC;
    }
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return []; }

    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          if (this.videoSequenceHeaderMissing) { return []; }
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return [];
        }
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
        if (metadata != null) { this.onMetadata ??= metadata; }
        return [];
      }
    }

    if (this.initializeSegment == null) {
      this.initializeSegment = this.create_initialize_segment(payload);
      if (this.initializeSegment == null) { return []; }
      const frames = [... this.waitingFrames, payload];
      this.waitingFrames = [];
      return frames.map((frame) => this.write(frame)).filter((fragment) => fragment != null);
    }

    const fragment = this.write(payload);
    return fragment == null ? [] : [fragment];
  }

  private write(payload: Frame): FMP4Fragment | null {
    switch (payload.kind) {
      case 'Video': {
        if (!this.hasVideo) { return null; }
        const previous = this.previousVideoInformation;
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        if (previous == null) { return null; }

        const { type, dts, cto, data } = previous;
        const duration = Math.max(0, payload.timestamp - dts);
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
          independent: !this.hasVideo,
        };
      }
    }
  }
}

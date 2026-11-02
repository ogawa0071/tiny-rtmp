import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import { read_avc_decoder_configuration_record } from '../../03-tiny-http-ts-server/src/avc.mts';
import handle_rtmp_payload, { AACPacketType, AudioCodecType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import { fragment, initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';
import { write_mp4_avc_track_information } from '../../06-tiny-http-fmp4-server/src/avc.mts';
import { write_mp4_aac_track_information } from '../../06-tiny-http-fmp4-server/src/aac.mts';

import SegmentTimeline from './segment-timeline.mts';
import { serializeXML, XMLNode } from './xml.mts';
import { aacMimeTypeCodec, avcMimeTypeCodec } from './mimetype.mts';

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const AAC_SAMPLES_PER_FRAME = 1024;

export default class DASHGenerator {
  private timestamps = new TimestampUnwrapper();
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;
  private firstAudioFormat: number | null = null;
  private videoSequenceHeaderMissing = false;
  private tracks: { video: boolean; audio: boolean; } | null = null;

  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;
  private audioCutPending = false;
  private videoSequenceNumber = 0;
  private audioSequenceNumber = 0;

  private liveWindowLength: number;
  private videoTimeline: SegmentTimeline | null = null;
  private audioTimeline: SegmentTimeline | null = null;

  private availabilityStartTime: Temporal.Instant | null = null;
  public readonly session = `${Date.now()}`;

  public constructor(liveWindowLength: number = 3) {
    this.liveWindowLength = liveWindowLength;
  }

  private hasVideo(): boolean {
    if (this.tracks != null) { return this.tracks.video; }
    if (this.avcDecoderConfigurationRecord != null) { return true; }
    if (this.videoSequenceHeaderMissing) { return false; }
    return this.onMetadata?.videocodecid === 7 || this.onMetadata?.videocodecid === 'avc1';
  }

  private hasAudio(): boolean {
    if (this.tracks != null) { return this.tracks.audio; }
    if (this.audioSpecificConfig != null) { return true; }
    if (this.firstAudioFormat != null) { return this.firstAudioFormat === AudioCodecType.AAC; }
    return this.onMetadata?.audiocodecid === 10 || this.onMetadata?.audiocodecid === 'mp4a';
  }

  private decideTracks(): void {
    if (this.tracks != null) { return; }
    if (!this.hasVideo() && !this.hasAudio()) { return; }
    if (this.hasVideo() && !(this.videoTimeline?.hasSegments() ?? false)) { return; }
    if (this.hasAudio() && !(this.audioTimeline?.hasSegments() ?? false)) { return; }
    this.tracks = { video: this.hasVideo(), audio: this.hasAudio() };
  }

  public mpd(): string | null {
    if (this.tracks == null) { return null; }

    const declaration = '<?xml version="1.0" encoding="UTF-8"?>';

    const mpd = XMLNode.from('MPD', {
      xmlns: 'urn:mpeg:dash:schema:mpd:2011',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': 'urn:mpeg:dash:schema:mpd:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd',
      profiles: 'urn:mpeg:dash:profile:isoff-live:2011',
      type: 'dynamic',
      availabilityStartTime: (this.availabilityStartTime ?? Temporal.Now.instant()).toString({ smallestUnit: 'millisecond' }),
      publishTime: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      minimumUpdatePeriod: 'PT1S',
      minBufferTime: 'PT2S',
    });
    const period = XMLNode.from('Period', { id: '0', start: 'PT0S' });

    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline != null) {
      const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
      const video_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'video',
        mimeType: 'video/mp4',
      });
      const video_representation = XMLNode.from('Representation', {
        id: '1',
        codecs: avcMimeTypeCodec(avcDecoderConfigurationRecord),
        bandwidth: `${this.videoTimeline.bandwidth()}`,
      });

      video_representation.children.push(this.videoTimeline.segment_template());
      video_adaptationset.children.push(video_representation);
      period.children.push(video_adaptationset);
    }
    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline != null) {
      const audioSpecificConfig = read_audio_specific_config(this.audioSpecificConfig);
      const audio_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'audio',
        mimeType: 'audio/mp4',
      });

      const audio_representation = XMLNode.from('Representation', {
        id: '2',
        codecs: aacMimeTypeCodec(audioSpecificConfig),
        bandwidth: `${this.audioTimeline.bandwidth()}`,
      });
      audio_representation.children.push(this.audioTimeline.segment_template());
      audio_adaptationset.children.push(audio_representation);
      period.children.push(audio_adaptationset);
    }
    mpd.children.push(period);

    return declaration + '\n' + serializeXML(mpd);
  }

  public segment(type: string, msn: number): Buffer | null {
    switch (type) {
      case 'video': return this.videoTimeline?.segment(msn) ?? null;
      case 'audio': return this.audioTimeline?.segment(msn) ?? null;
      default: return null;
    }
  }

  public initialize(type: string): Buffer | null {
    switch (type) {
      case 'video': return this.videoTimeline?.initialize() ?? null;
      case 'audio': return this.audioTimeline?.initialize() ?? null;
      default: return null;
    }
  }

  public feed(received: Message): void {
    const message = this.timestamps.unwrap(received);
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          if (this.videoSequenceHeaderMissing) { return; }
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return;
        }
        if (this.avcDecoderConfigurationRecord == null && !this.videoSequenceHeaderMissing) {
          logger.warn('Video sequence header is missing, video is ignored', { codec: payload.codec });
          this.videoSequenceHeaderMissing = true;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return;
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        if (metadata != null) { this.onMetadata ??= metadata; }
        return;
      }
    }

    this.availabilityStartTime ??= Temporal.Now.instant().subtract({ milliseconds: payload.timestamp });

    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline == null) {
      const initialization = make((vector) => {
        initialize(RTMP_TIMESCALE, [1], vector, (vector) => {
          vector.write(write_mp4_avc_track_information(1, RTMP_TIMESCALE, this.avcDecoderConfigurationRecord!));
        });
      });
      this.videoTimeline = new SegmentTimeline(`video_${this.session}`, RTMP_TIMESCALE, initialization, { liveWindowLength: this.liveWindowLength });
    }
    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline == null) {
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      const initialization = make((vector) => {
        initialize(samplingFrequency, [1], vector, (vector) => {
          vector.write(write_mp4_aac_track_information(1, samplingFrequency, this.audioSpecificConfig!));
        });
      });
      this.audioTimeline = new SegmentTimeline(`audio_${this.session}`, samplingFrequency, initialization, { liveWindowLength: this.liveWindowLength });
    }

    switch (payload.kind) {
      case 'Video': {
        if (this.videoTimeline == null) { return; }
        if (this.previousVideoInformation != null) {
          const { type, dts, cto, data } = this.previousVideoInformation;
          const duration = Math.max(0, payload.timestamp - dts);
          this.videoTimeline.feed(make((vector) => {
            fragment({ sequence_number: ++this.videoSequenceNumber, track_id: 1, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto }, data, vector);
          }));
        }
        if (payload.frameType === FrameType.KEY_FRAME && this.videoTimeline.append(payload.timestamp)) {
          this.audioCutPending = true;
        }
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        break;
      }
      case 'Audio': {
        if (this.audioTimeline == null) { return; }
        if (this.audioSpecificConfig == null) { return; }
        const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
        const timestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        if (this.aacLatestTimestamp == null) {
          this.audioTimeline.append(timestamp);
        }
        if (this.aacLatestTimestamp == null || Math.abs(this.aacLatestTimestamp + AAC_SAMPLES_PER_FRAME - timestamp) > AAC_SAMPLES_PER_FRAME) {
          this.aacLatestTimestamp = timestamp;
        } else {
          this.aacLatestTimestamp += AAC_SAMPLES_PER_FRAME;
        }
        const dts = this.aacLatestTimestamp;
        if (this.audioCutPending) {
          this.audioTimeline.append(dts, true);
          this.audioCutPending = false;
        }
        if (!this.hasVideo()) { this.audioTimeline.append(dts); }
        this.audioTimeline.feed(make((vector) => {
          fragment({ sequence_number: ++this.audioSequenceNumber, track_id: 1, keyframe: true, duration: AAC_SAMPLES_PER_FRAME, dts, cto: 0 }, payload.data, vector);
        }));
        break;
      }
    }
    this.decideTracks();
  }
}

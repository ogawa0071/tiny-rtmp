import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import { read_avc_decoder_configuration_record } from '../../03-tiny-http-ts-server/src/avc.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, read_onmetadata } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

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
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;

  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;

  private liveWindowLength: number;
  private videoTimeline: SegmentTimeline | null = null;
  private audioTimeline: SegmentTimeline | null = null;

  private avail = new Date().toISOString();

  public constructor(liveWindowLength: number = 3) {
    this.liveWindowLength = liveWindowLength;
  }

  public mpd(): string {
    const declaration = '<?xml version="1.0" encoding="UTF-8"?>';

    const mpd = XMLNode.from('MPD', {
      xmlns: 'urn:mpeg:dash:schema:mpd:2011',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': 'urn:mpeg:dash:schema:mpd:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd',
      profiles: 'urn:mpeg:dash:profile:isoff-live:2011',
      type: 'dynamic',
      availabilityStartTime: this.avail,
      publishTime: new Date().toISOString(),
      minimumUpdatePeriod: 'PT1S',
      minBufferTime: 'PT2S',
    });
    const period = XMLNode.from('Period', { start: 'PT0S' });

    if (this.onMetadata?.videocodecid != null && this.avcDecoderConfigurationRecord != null && this.videoTimeline != null) {
      const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
      const video_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'video',
        mimeType: 'video/mp4',
      });
      const video_representation = XMLNode.from('Representation', {
        id: '1',
        codecs: avcMimeTypeCodec(avcDecoderConfigurationRecord),
      });

      video_representation.children.push(this.videoTimeline.segment_template());
      video_adaptationset.children.push(video_representation);
      period.children.push(video_adaptationset);
    }
    if (this.onMetadata?.audiocodecid != null && this.audioSpecificConfig != null && this.audioTimeline != null) {
      const audioSpecificConfig = read_audio_specific_config(this.audioSpecificConfig);
      const audio_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'audio',
        mimeType: 'audio/mp4',
      });

      const audio_representation = XMLNode.from('Representation', {
        id: '2',
        codecs: aacMimeTypeCodec(audioSpecificConfig),
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

  public feed(message: Message): void {
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return;
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
        if (metadata != null) { this.onMetadata = metadata; }
        return;
      }
    }

    if (this.onMetadata == null) { return; }

    // 初期化情報が揃ったトラックから、初期化セグメントを作ってセグメントを並べ始める
    if (this.onMetadata.videocodecid != null && this.avcDecoderConfigurationRecord != null && this.videoTimeline == null) {
      const initialization = make((vector) => {
        initialize(RTMP_TIMESCALE, [1], vector, (vector) => {
          vector.write(write_mp4_avc_track_information(1, RTMP_TIMESCALE, this.avcDecoderConfigurationRecord!));
        });
      });
      this.videoTimeline = new SegmentTimeline('video', RTMP_TIMESCALE, initialization, { liveWindowLength: this.liveWindowLength });
    }
    if (this.onMetadata.audiocodecid != null && this.audioSpecificConfig != null && this.audioTimeline == null) {
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      const initialization = make((vector) => {
        initialize(samplingFrequency, [1], vector, (vector) => {
          vector.write(write_mp4_aac_track_information(1, samplingFrequency, this.audioSpecificConfig!));
        });
      });
      this.audioTimeline = new SegmentTimeline('audio', samplingFrequency, initialization, { liveWindowLength: this.liveWindowLength });
    }

    switch (payload.kind) {
      case 'Video': {
        if (this.videoTimeline == null) { return; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        if (this.previousVideoInformation != null) {
          const { type, dts, cto, data } = this.previousVideoInformation;
          const duration = payload.timestamp - dts;
          this.videoTimeline.feed(make((vector) => {
            fragment({ track_id: 1, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto }, data, vector);
          }));
        }
        // 1 つ前のフレームを今のセグメントに書き出してから、キーフレームで新しいセグメントを始める
        if (payload.frameType === FrameType.KEY_FRAME) {
          this.videoTimeline.append(payload.timestamp);
          // 音声も同じタイミングで区切る (次に届く音声フレームから新しいセグメントに入れる)
          if (this.aacLatestTimestamp != null) {
            this.audioTimeline?.append(this.aacLatestTimestamp + AAC_SAMPLES_PER_FRAME);
          }
        }
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        return;
      }
      case 'Audio': {
        if (this.audioTimeline == null) { return; }
        if (this.audioSpecificConfig == null) { return; }
        // AAC は 1 フレームが 1024 サンプルなので、最初のフレームの timestamp から 1024 ずつ進める
        if (this.aacLatestTimestamp == null) {
          const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
          this.aacLatestTimestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        } else {
          this.aacLatestTimestamp += AAC_SAMPLES_PER_FRAME;
        }
        const dts = this.aacLatestTimestamp;
        this.audioTimeline.feed(make((vector) => {
          fragment({ track_id: 1, keyframe: true, duration: AAC_SAMPLES_PER_FRAME, dts, cto: 0 }, payload.data, vector);
        }));
        return;
      }
    }
  }
}

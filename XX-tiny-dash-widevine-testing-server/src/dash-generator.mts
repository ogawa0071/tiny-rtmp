import crypto from 'node:crypto';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import handle_rtmp_payload, { AACPacketType, AudioCodecType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import { read_avc_decoder_configuration_record } from '../../03-tiny-http-ts-server/src/avc.mts';

import { initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';

import SegmentTimeline from '../../07-tiny-dash-server/src/segment-timeline.mts';
import { serializeXML, XMLNode } from '../../07-tiny-dash-server/src/xml.mts';
import { aacMimeTypeCodec, avcMimeTypeCodec } from '../../07-tiny-dash-server/src/mimetype.mts';

import { encrypt_avc, read_parameter_sets, write_mp4_avc_track_information, type ParameterSets } from '../../08-tiny-dash-cenc-server/src/avc.mts';
import { encrypt_aac, write_mp4_aac_track_information } from '../../08-tiny-dash-cenc-server/src/aac.mts';
import { EncryptionFormat, EncryptionScheme, fragment, IVType, pssh } from '../../08-tiny-dash-cenc-server/src/cenc.mts';

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const AAC_SAMPLES_PER_FRAME = 1024;
const WIDEVINE_SYSTEM_ID = Buffer.from('edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'.replaceAll('-', ''), 'hex');
const WIDEVINE_PSSH_DATA = Buffer.from('CAESEJA1GVFoa14boiJDns7B8SoaDXdpZGV2aW5lX3Rlc3QiASo', 'base64'); // テスト用の PSSH (Protocol Buffers のデータ)

export default class DASHGenerator {
  private timestamps = new TimestampUnwrapper();
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private parameterSets: ParameterSets | null = null;
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

  private encryptionFormat: EncryptionFormat;
  private ivSize: number;
  private ivType: IVType;
  private keyId: Buffer;
  private key: Buffer;

  private availabilityStartTime: Temporal.Instant | null = null;
  public readonly session = `${Date.now()}`;

  public constructor(format: EncryptionFormat, keyId: Buffer, key: Buffer, liveWindowLength: number = 3) {
    this.liveWindowLength = liveWindowLength;
    this.encryptionFormat = format;
    this.ivSize = this.encryptionFormat.bytes;
    this.ivType = format.scheme === EncryptionScheme.CENC ? {
      type: IVType.PER_SAMPLE,
      per_sample_iv_size: this.ivSize,
    } : {
      type: IVType.CONSTANT,
      constant_iv: crypto.randomBytes(this.ivSize),
    };
    this.keyId = keyId;
    this.key = key;
  }

  private mp4protection(): XMLNode {
    const kid = this.keyId.toString('hex');
    return XMLNode.from('ContentProtection', {
      schemeIdUri: 'urn:mpeg:dash:mp4protection:2011',
      value: this.encryptionFormat.scheme,
      'cenc:default_KID': `${kid.slice(0, 8)}-${kid.slice(8, 12)}-${kid.slice(12, 16)}-${kid.slice(16, 20)}-${kid.slice(20)}`,
    });
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
      'xmlns:cenc': 'urn:mpeg:cenc:2013',
      'xmlns:clearkey': 'http://dashif.org/guidelines/clearKey',
      'xsi:schemaLocation': 'urn:mpeg:dash:schema:mpd:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd',
      profiles: 'urn:mpeg:dash:profile:isoff-live:2011',
      type: 'dynamic',
      availabilityStartTime: (this.availabilityStartTime ?? Temporal.Now.instant()).toString({ smallestUnit: 'millisecond' }),
      publishTime: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      minimumUpdatePeriod: 'PT1S',
      minBufferTime: 'PT2S',
    });
    const period = XMLNode.from('Period', { id: '0', start: 'PT0S' });
    const widevine_protection = XMLNode.from('ContentProtection', {
      schemeIdUri: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed',
    }, [
      XMLNode.from('cenc:pssh', {}, [make((vector) => { pssh(WIDEVINE_SYSTEM_ID, [this.keyId], WIDEVINE_PSSH_DATA, vector); }).toString('base64')]),
    ]);

    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline != null) {
      const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
      const video_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'video',
        mimeType: 'video/mp4',
      });

      video_adaptationset.children.push(this.mp4protection(), widevine_protection);

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

      audio_adaptationset.children.push(this.mp4protection(), widevine_protection);

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
          this.parameterSets = read_parameter_sets(read_avc_decoder_configuration_record(payload.avcDecoderConfigurationRecord));
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
          vector.write(write_mp4_avc_track_information(1, RTMP_TIMESCALE, this.encryptionFormat, this.ivType, this.keyId, this.avcDecoderConfigurationRecord!));
          pssh(WIDEVINE_SYSTEM_ID, [this.keyId], WIDEVINE_PSSH_DATA, vector); // 本当は v0 の方がいい
        });
      });
      this.videoTimeline = new SegmentTimeline(`video_${this.session}`, RTMP_TIMESCALE, initialization, { liveWindowLength: this.liveWindowLength });
    }
    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline == null) {
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      const initialization = make((vector) => {
        initialize(samplingFrequency, [1], vector, (vector) => {
          vector.write(write_mp4_aac_track_information(1, samplingFrequency, this.encryptionFormat, this.ivType, this.keyId, this.audioSpecificConfig!));
          pssh(WIDEVINE_SYSTEM_ID, [this.keyId], WIDEVINE_PSSH_DATA, vector); // 本当は v0 の方がいい
        });
      });
      this.audioTimeline = new SegmentTimeline(`audio_${this.session}`, samplingFrequency, initialization, { liveWindowLength: this.liveWindowLength });
    }

    switch (payload.kind) {
      case 'Video': {
        if (this.videoTimeline == null) { return; }
        if (this.avcDecoderConfigurationRecord == null) { return; }
        if (this.previousVideoInformation != null) {
          const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
          const { type, dts, cto, data } = this.previousVideoInformation;
          const duration = Math.max(0, payload.timestamp - dts);
          this.videoTimeline.feed(make((vector) => {
            const iv = this.ivType.type === IVType.CONSTANT ? this.ivType.constant_iv : crypto.randomBytes(this.ivSize);
            const [encrypted, subsample] = encrypt_avc(this.encryptionFormat, this.key, iv, data, avcDecoderConfigurationRecord, this.parameterSets!);

            fragment(
              { sequence_number: ++this.videoSequenceNumber, track_id: 1, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto },
              { iv, subsamples: subsample },
              this.ivType.type,
              encrypted,
              vector
            );
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
          const iv = this.ivType.type === IVType.CONSTANT ? this.ivType.constant_iv : crypto.randomBytes(this.ivSize);
          const [encrypted, subsample] = encrypt_aac(this.encryptionFormat, this.key, iv, payload.data);

          fragment(
            { sequence_number: ++this.audioSequenceNumber, track_id: 1, keyframe: true, duration: AAC_SAMPLES_PER_FRAME, dts, cto: 0 },
            { iv, subsamples: subsample },
            this.ivType.type,
            encrypted,
            vector
          );
        }));
        break;
      }
    }
    this.decideTracks();
  }
}

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { read_avc_decoder_configuration_record, write_annexb_avc } from './avc.mts';
import type { AVCDecoderConfigurationRecord } from './avc.mts';
import { read_audio_specific_config, write_adts_aac } from './aac.mts';
import type { AudioSpecificConfig } from './aac.mts';
import handle_rtmp_payload, { AACPacketType, AudioCodecType, PacketType, read_onmetadata, VideoCodecType } from './rtmp-handler.mts';
import { SectionPacketizer, PESPacketizer, PCRPacketizer, write_pat, write_pmt, write_pes, StreamType } from './mpegts.mts';
import type { PAT, PMT } from './mpegts.mts';

const PMT_PID = 256;
const PCR_PID = 257;
const AVC_PID = 258;
const AAC_PID = 259;
const PAT_DATA = {
  transport_stream_id: 0,
  programs: [{
    program_number: 1,
    program_map_PID: PMT_PID,
  }],
} as const satisfies PAT;
const AVC_STREAM = {
  stream_type: StreamType.AVC,
  elementary_PID: AVC_PID,
} as const satisfies PMT['streams'][number];
const AAC_STREAM = {
  stream_type: StreamType.AAC_ADTS,
  elementary_PID: AAC_PID,
} as const satisfies PMT['streams'][number];
const PSI_INTERVAL = 100;
const PCR_INTERVAL = 50;
const DECODE_DELAY = 700;

const timestamp_from_rtmp_to_mpegts = (timestamp: number): number => {
  return ((timestamp * 90) % 2 ** 33 + 2 ** 33) % 2 ** 33;
};

export default class MPEGTSTransmuxer {
  private avcDecoderConfigurationRecord: AVCDecoderConfigurationRecord | null = null;
  private audioSpecificConfig: AudioSpecificConfig | null = null;
  private patPacketizer = new SectionPacketizer(0);
  private pmtPacketizer = new SectionPacketizer(PMT_PID);
  private pcrPacketizer = new PCRPacketizer(PCR_PID);
  private avcPacketizer = new PESPacketizer(AVC_PID);
  private aacPacketizer = new PESPacketizer(AAC_PID);
  private last_PSI_timestamp: number | null = null;
  private last_PCR_timestamp: number | null = null;
  private onMetadata: AMF0Object | null = null;
  private firstVideoIsAVC: boolean | null = null;
  private firstAudioIsAAC: boolean | null = null;
  private videoSequenceHeaderMissing = false;
  private pmtStreams: [boolean, boolean] | null = null;
  private pmtVersion = 0;

  public hasVideo(): boolean {
    if (this.videoSequenceHeaderMissing) { return false; }
    if (this.pmtStreams?.[0] === false) { return false; }
    if (this.firstVideoIsAVC != null) { return this.firstVideoIsAVC; }
    if (!this.declared()) { return true; }
    return this.onMetadata?.videocodecid === VideoCodecType.AVC || this.onMetadata?.videocodecid === 'avc1';
  }

  public hasAudio(): boolean {
    if (this.pmtStreams?.[1] === false) { return false; }
    if (this.firstAudioIsAAC != null) { return this.firstAudioIsAAC; }
    if (!this.declared()) { return true; }
    return this.onMetadata?.audiocodecid === AudioCodecType.AAC || this.onMetadata?.audiocodecid === 'mp4a';
  }

  public decided(): boolean {
    return (!this.hasVideo() || this.avcDecoderConfigurationRecord != null) && (!this.hasAudio() || this.firstAudioIsAAC != null);
  }

  private declared(): boolean {
    return this.onMetadata?.videocodecid != null || this.onMetadata?.audiocodecid != null;
  }

  public resetPSI(): void {
    this.last_PSI_timestamp = null;
  }

  private *emitPSIAndPCR(timestamp: number): Generator<Buffer> {
    const video = this.hasVideo();
    const audio = this.hasAudio();
    if (this.pmtStreams != null && (this.pmtStreams[0] !== video || this.pmtStreams[1] !== audio)) {
      this.pmtVersion = (this.pmtVersion + 1) % 32;
      this.last_PSI_timestamp = null;
    }
    if (this.last_PSI_timestamp == null || (timestamp - this.last_PSI_timestamp) >= PSI_INTERVAL) {
      yield* this.patPacketizer.packetize(write_pat(PAT_DATA));
      yield* this.pmtPacketizer.packetize(write_pmt({
        program_number: 1,
        version_number: this.pmtVersion,
        pcr_pid: PCR_PID,
        streams: [... (video ? [AVC_STREAM] : []), ... (audio ? [AAC_STREAM] : [])],
      }));
      this.pmtStreams = [video, audio];
      this.last_PSI_timestamp = timestamp;
    }
    if (this.last_PCR_timestamp == null || (timestamp - this.last_PCR_timestamp) >= PCR_INTERVAL) {
      yield this.pcrPacketizer.packetize(timestamp_from_rtmp_to_mpegts(timestamp));
      this.last_PCR_timestamp = timestamp;
    }
  }

  public feed(message: Message): Iterable<Buffer> {
    if (message.message_type_id === MessageType.Video && message.data.byteLength >= 1) {
      this.firstVideoIsAVC ??= (message.data[0] & 0x80) === 0 && (message.data[0] & 0x0F) === VideoCodecType.AVC;
    }
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioIsAAC ??= (message.data[0] >> 4) === AudioCodecType.AAC;
    }
    const payload = handle_rtmp_payload(message);
    switch (payload?.kind) {
      case 'Video': {
        if (!this.hasVideo()) { return []; }
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(payload.avcDecoderConfigurationRecord);
          return [];
        }
        if (this.avcDecoderConfigurationRecord == null) {
          logger.warn('Video sequence header is missing, video is ignored', { codec: payload.codec });
          this.videoSequenceHeaderMissing = true;
          return [];
        }
        const pes = write_pes(
          write_annexb_avc(payload.data, this.avcDecoderConfigurationRecord),
          0xe0,
          timestamp_from_rtmp_to_mpegts(payload.timestamp + payload.compositionTimeOffset + DECODE_DELAY),
          timestamp_from_rtmp_to_mpegts(payload.timestamp + DECODE_DELAY),
          true
        );
        return this.packetize(this.avcPacketizer, pes, payload.timestamp);
      }
      case 'Audio': {
        if (!this.hasAudio()) { return []; }
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = read_audio_specific_config(payload.audioSpecificConfig);
          return [];
        }
        if (this.audioSpecificConfig == null) { return []; }
        if (payload.data.byteLength === 0) { return []; }
        const pes = write_pes(
          write_adts_aac(payload.data, this.audioSpecificConfig),
          0xc0,
          timestamp_from_rtmp_to_mpegts(payload.timestamp + DECODE_DELAY),
          null,
          false
        );
        return this.packetize(this.aacPacketizer, pes, payload.timestamp);
      }
      case 'Data': {
        this.onMetadata ??= read_onmetadata(payload.values);
        return [];
      }
      default:
        return [];
    }
  }

  private *packetize(packetizer: PESPacketizer, pes: Buffer, timestamp: number): Generator<Buffer> {
    yield* this.emitPSIAndPCR(timestamp);
    yield* packetizer.packetize(pes);
  }
}

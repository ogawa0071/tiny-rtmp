import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import { read_avc_decoder_configuration_record, write_annexb_avc } from './avc.mts';
import type { AVCDecoderConfigurationRecord } from './avc.mts';
import { read_audio_specific_config, write_adts_aac } from './aac.mts';
import type { AudioSpecificConfig } from './aac.mts';
import handle_rtmp_payload, { AACPacketType, PacketType } from './rtmp-handler.mts';
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
const PMT_DATA = {
  program_number: 1,
  pcr_pid: PCR_PID,
  streams: [{
    stream_type: StreamType.AVC,
    elementary_PID: AVC_PID,
  }, {
    stream_type: StreamType.AAC_ADTS,
    elementary_PID: AAC_PID,
  }],
} as const satisfies PMT;
// 途中から受信した側もデコードを始められるように、PAT/PMT を定期的 (ミリ秒) に出力する
const PSI_INTERVAL = 100;
// PCR (デコーダの時計) は 100ms 以内の間隔で出力する必要がある (H.222.0 2.7.2)
// 次の映像/音声が届くまで出力できないので、その分の余裕を見て半分の間隔にする
const PCR_INTERVAL = 50;
// PTS/DTS を PCR より遅らせる時間 (ミリ秒)
// データが届いてからデコードするまでの猶予で、ないとデコードする時刻にデータが届き終わらない (FFmpeg の -muxdelay と同じ)
const DECODE_DELAY = 700;

// RTMP の timestamp (ミリ秒) を MPEG-TS の 90kHz (33bit) に変換する (負の値も 33bit で一周させて正の値にする)
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

  // 次の映像/音声の前に必ず PAT/PMT から出力させる (HLS でセグメントの先頭にする時などに使う)
  public resetPSI(): void {
    this.last_PSI_timestamp = null;
  }

  // 映像/音声の PES の前に、必要なら PAT/PMT/PCR を出力する (時刻は映像/音声の timestamp で決める)
  private *emitPSIAndPCR(timestamp: number): Generator<Buffer> {
    if (this.last_PSI_timestamp == null || (timestamp - this.last_PSI_timestamp) >= PSI_INTERVAL) {
      yield* this.patPacketizer.packetize(write_pat(PAT_DATA));
      yield* this.pmtPacketizer.packetize(write_pmt(PMT_DATA));
      this.last_PSI_timestamp = timestamp;
    }
    // 映像と音声の timestamp は前後しうるが、PCR は巻き戻ってはいけないので、前の PCR より進んだ時だけ出力する
    if (this.last_PCR_timestamp == null || (timestamp - this.last_PCR_timestamp) >= PCR_INTERVAL) {
      yield this.pcrPacketizer.packetize(timestamp_from_rtmp_to_mpegts(timestamp));
      this.last_PCR_timestamp = timestamp;
    }
  }

  public *feed(message: Message): Generator<Buffer> {
    const payload = handle_rtmp_payload(message);
    switch (payload?.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(payload.avcDecoderConfigurationRecord);
          return;
        }
        if (this.avcDecoderConfigurationRecord == null) { return; }
        yield* this.emitPSIAndPCR(payload.timestamp);
        yield* this.avcPacketizer.packetize(
          write_pes(
            write_annexb_avc(payload.data, this.avcDecoderConfigurationRecord),
            0xe0, // 0b1110XXXX: H.262/H.263/H.264/H.265 Video, stream number = 0
            timestamp_from_rtmp_to_mpegts(payload.timestamp + payload.compositionTimeOffset + DECODE_DELAY),
            timestamp_from_rtmp_to_mpegts(payload.timestamp + DECODE_DELAY),
            true
          )
        );
        return;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = read_audio_specific_config(payload.audioSpecificConfig);
          return;
        }
        if (this.audioSpecificConfig == null) { return; }
        // 中身のない AAC のフレームは ADTS にできないので送らない (raw_data_block は終端の ID_END だけでも 1 byte ある)
        if (payload.data.byteLength === 0) { return; }
        yield* this.emitPSIAndPCR(payload.timestamp);
        yield* this.aacPacketizer.packetize(
          write_pes(
            write_adts_aac(payload.data, this.audioSpecificConfig),
            0xc0, // 0b110XXXXX: AAC Audio, stream number = 0
            timestamp_from_rtmp_to_mpegts(payload.timestamp + DECODE_DELAY),
            null,
            false
          )
        );
        return;
    }
  }
}

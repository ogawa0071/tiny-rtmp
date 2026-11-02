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
// PMT に載せる映像 (AVC) と音声 (ADTS の AAC) の ES
const AVC_STREAM = {
  stream_type: StreamType.AVC,
  elementary_PID: AVC_PID,
} as const satisfies PMT['streams'][number];
const AAC_STREAM = {
  stream_type: StreamType.AAC_ADTS,
  elementary_PID: AAC_PID,
} as const satisfies PMT['streams'][number];
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
  // 最初に届いた onMetaData (映像・音声のメッセージがまだ届いていないトラックは、これに書かれたコーデックで決める: hasVideo, hasAudio)
  private onMetadata: AMF0Object | null = null;
  // 最初に届いた映像のメッセージが、従来の形式の H.264 (AVC) か (Enhanced RTMP の HEVC などや Sorenson H.263 なら false)
  private firstVideoIsAVC: boolean | null = null;
  // 最初に届いた音声のメッセージが AAC か (MP3 などなら false)
  private firstAudioIsAAC: boolean | null = null;
  // 初期化情報より先に AVC のフレームが届いたか (その映像は使わずに、映像のない配信として扱う: feed)
  private videoSequenceHeaderMissing = false;
  // 最後に出力した PMT に載せた ES (映像, 音声) と、その PMT の version_number
  private pmtStreams: [boolean, boolean] | null = null;
  private pmtVersion = 0;

  // PMT に AVC の ES を載せて、映像を MPEG-TS にするか (載せないなら、映像のない配信: HLS では音声のフレームで区切る)
  // PMT には、データの届く ES だけを載せる (FFmpeg の MPEG-TS と同じ)
  // (データの届かない ES まで載せると、届かないフレームを待って再生を始めないプレイヤー (mpegts.js など) がある)
  // 映像・音声は、もう届いていれば最初に届いたメッセージのコーデックで、まだ届いていなければ onMetaData で決める (06 の FMP4Transmuxer と同じ)
  // (コーデックを数値ではなく 'avc1' や 'mp4a' の文字列で送ってくる配信ソフトもある)
  // onMetaData を送ってこない配信ソフトや、onMetaData にコーデックを書かない配信ソフト (yasea など) では、届くまで分からないので載せておく
  // 載せずに PMT を出力した ES は、後からそのトラックが届いても載せない (FFmpeg も、出力を始めた後から届いたトラックは使わない。06 以降の初期化セグメントと同じ)
  // (MSE で再生するプレイヤー (mpegts.js や hls.js など) は、再生を始めた後からトラックを増やせずにエラーになる)
  public hasVideo(): boolean {
    if (this.videoSequenceHeaderMissing) { return false; }
    if (this.pmtStreams?.[0] === false) { return false; }
    if (this.firstVideoIsAVC != null) { return this.firstVideoIsAVC; }
    if (!this.declared()) { return true; }
    return this.onMetadata?.videocodecid === VideoCodecType.AVC || this.onMetadata?.videocodecid === 'avc1';
  }

  // PMT に AAC の ES を載せて、音声を MPEG-TS にするか (hasVideo と同じように決める)
  public hasAudio(): boolean {
    if (this.pmtStreams?.[1] === false) { return false; }
    if (this.firstAudioIsAAC != null) { return this.firstAudioIsAAC; }
    if (!this.declared()) { return true; }
    return this.onMetadata?.audiocodecid === AudioCodecType.AAC || this.onMetadata?.audiocodecid === 'mp4a';
  }

  // PMT に載せる ES が決まったか (映像・音声のそれぞれで、載せないと分かったか、載せると分かったか)
  // 映像は AVC の初期化情報が届いたら決まり (中身が空の初期化情報しか届かずにフレームが届いたら、載せないと決まる: feed)、音声は最初の音声のメッセージが届いたら決まる
  // (HTTP-TS 配信 (index.mts) は、配信の始めは決まるまで TS パケットにするのを待つ: decision-wait.mts。決まる前に出力した PMT に、後から載せないと分かった ES が載っていると、
  //  version_number を増やした PMT でその ES を外しても、mpegts.js などは最初の PMT に載っていた ES のデータを待って再生を始めない)
  public decided(): boolean {
    return (!this.hasVideo() || this.avcDecoderConfigurationRecord != null) && (!this.hasAudio() || this.firstAudioIsAAC != null);
  }

  // onMetaData に映像か音声のコーデックが書かれているか
  private declared(): boolean {
    return this.onMetadata?.videocodecid != null || this.onMetadata?.audiocodecid != null;
  }

  // 次の映像/音声の前に必ず PAT/PMT から出力させる (HLS でセグメントの先頭にする時などに使う)
  public resetPSI(): void {
    this.last_PSI_timestamp = null;
  }

  // 映像/音声の PES の前に、必要なら PAT/PMT/PCR を出力する (時刻は映像/音声の timestamp で決める)
  private *emitPSIAndPCR(timestamp: number): Generator<Buffer> {
    // PMT に載せる ES が変わったら (最初に届いた映像が H.264 ではなかった、初期化情報より先に映像のフレームが届いた、など。ES が増えることはない: hasVideo)、
    // version_number を 1 増やして (32 で 0 に戻る)、すぐに PMT を出力する
    // (PMT の中身を変えたら version_number を 1 増やす: H.222.0 2.4.4.9。version_number が同じ PMT を読み直さないプレイヤー (VLC や GStreamer など) は、増やさないと変わったことに気付かない)
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
    // 映像と音声の timestamp は前後しうるが、PCR は巻き戻ってはいけないので、前の PCR より進んだ時だけ出力する
    if (this.last_PCR_timestamp == null || (timestamp - this.last_PCR_timestamp) >= PCR_INTERVAL) {
      yield this.pcrPacketizer.packetize(timestamp_from_rtmp_to_mpegts(timestamp));
      this.last_PCR_timestamp = timestamp;
    }
  }

  // 映像/音声のメッセージを TS パケットにする (onMetaData は、PMT に載せる ES を決めるのに使う)
  // 中身の解析と Annex B / ADTS への変換はここですぐに行い (壊れたデータなら、このメッセージの feed で例外になる)、
  // PAT/PMT/PCR と PES を TS パケットにするのは、返したジェネレータから取り出す時に行う
  // (LL-HLS では、どのパーシャルセグメントに入れるかを決めてから取り出して、パーシャルセグメントの先頭に PAT/PMT を入れる)
  public feed(message: Message): Iterable<Buffer> {
    // 映像と音声のコーデックは、最初に届いた映像と音声のメッセージで決める (hasVideo, hasAudio)
    // (handle_rtmp_payload は H.264 以外の映像や AAC 以外の音声、中身が空の初期化情報には null を返すので、VideoTagHeader と AudioTagHeader の先頭を見る)
    // (映像は先頭 1bit が立っていれば Enhanced RTMP の形式で、そうでなければ下位 4bit が CodecID。音声は先頭 4bit が SoundFormat)
    if (message.message_type_id === MessageType.Video && message.data.byteLength >= 1) {
      this.firstVideoIsAVC ??= (message.data[0] & 0x80) === 0 && (message.data[0] & 0x0F) === VideoCodecType.AVC;
    }
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioIsAAC ??= (message.data[0] >> 4) === AudioCodecType.AAC;
    }
    const payload = handle_rtmp_payload(message);
    switch (payload?.kind) {
      case 'Video': {
        // PMT に載せない映像は MPEG-TS にしない (最初に届いた映像が H.264 ではなかった時や、初期化情報より先にフレームが届いた時: 下)
        if (!this.hasVideo()) { return []; }
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(payload.avcDecoderConfigurationRecord);
          return [];
        }
        // 初期化情報より先に映像のフレームが届いたら、その映像は使わずに、映像のない配信として扱う (06 以降のサーバと同じ。後から初期化情報が届いても使わない)
        // (FFmpeg 6.0 以前で初期化情報を出さないエンコーダの H.264 を送ると、中身が空の初期化情報しか届かない: rtmp-handler.mts の handle_avc。
        //  その時のフレームは開始コード付き (Annex B) のままで、FFmpeg はそれを MPEG-TS にするが、このサーバはフレームを長さ付きの NAL Unit として読むので扱わない: write_annexb_avc)
        if (this.avcDecoderConfigurationRecord == null) {
          logger.warn('Video sequence header is missing, video is ignored', { codec: payload.codec });
          this.videoSequenceHeaderMissing = true;
          return [];
        }
        const pes = write_pes(
          write_annexb_avc(payload.data, this.avcDecoderConfigurationRecord),
          0xe0, // 0b1110XXXX: H.262/H.263/H.264/H.265 Video, stream number = 0
          timestamp_from_rtmp_to_mpegts(payload.timestamp + payload.compositionTimeOffset + DECODE_DELAY),
          timestamp_from_rtmp_to_mpegts(payload.timestamp + DECODE_DELAY),
          true
        );
        return this.packetize(this.avcPacketizer, pes, payload.timestamp);
      }
      case 'Audio': {
        // PMT に載せない音声は MPEG-TS にしない (最初に届いた音声が AAC ではなかった時)
        if (!this.hasAudio()) { return []; }
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = read_audio_specific_config(payload.audioSpecificConfig);
          return [];
        }
        if (this.audioSpecificConfig == null) { return []; }
        // 中身のない AAC のフレームは ADTS にできないので送らない (raw_data_block は終端の ID_END だけでも 1 byte ある)
        if (payload.data.byteLength === 0) { return []; }
        const pes = write_pes(
          write_adts_aac(payload.data, this.audioSpecificConfig),
          0xc0, // 0b110XXXXX: AAC Audio, stream number = 0
          timestamp_from_rtmp_to_mpegts(payload.timestamp + DECODE_DELAY),
          null,
          false
        );
        return this.packetize(this.aacPacketizer, pes, payload.timestamp);
      }
      case 'Data': {
        // PMT に載せる ES は最初の onMetaData で決める (曲名だけを書いた onMetaData などが送り直されても変えない)
        this.onMetadata ??= read_onmetadata(payload.values);
        return [];
      }
      default:
        return [];
    }
  }

  // PES を TS パケットにする (必要なら、その前に PAT/PMT/PCR を出力する)
  private *packetize(packetizer: PESPacketizer, pes: Buffer, timestamp: number): Generator<Buffer> {
    yield* this.emitPSIAndPCR(timestamp);
    yield* packetizer.packetize(pes);
  }
}

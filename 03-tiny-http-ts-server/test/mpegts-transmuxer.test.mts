import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import type { Logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import MPEGTSTransmuxer from '../src/mpegts-transmuxer.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
// FFmpeg が、まだ初期化情報がない時に送ってくる中身が空の AVC の初期化情報
const EMPTY_AVC_SEQUENCE_HEADER = Buffer.from('1700000000', 'hex');
// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、AAC と MP3 (SoundFormat 2) のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');
const MP3_FRAME = Buffer.from('2fff', 'hex');
// Enhanced RTMP の H.265 のフレーム (このサーバでは扱わない)
const HEVC_FRAME = Buffer.from('9168766331000000', 'hex');
// Enhanced RTMP の onMetaData の videocodecid ('hvc1' の FourCC を数値にしたもの)
const HEVC_FOURCC = 0x68766331;

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// 48 kHz の AAC (1 フレーム 1024 サンプル) の i 番目のフレームの timestamp (ミリ秒に丸める)
const aac = (i: number): number => Math.round(i * 1024 * 1000 / 48000);

// 映像と音声のトラック (初期化情報があれば、最初のフレームの前に送る)
type Track = { header: Buffer | null; frame: (t: number) => Buffer; };
// 10 fps の AVC (1 秒ごとにキーフレーム)
const AVC: Track = { header: AVC_SEQUENCE_HEADER, frame: (t) => avc(t % 1000 === 0 ? 1 : 2) };
// 初期化情報の届かない AVC (FFmpeg 6.0 以前で、初期化情報を出さないエンコーダの H.264 を送った時)
const AVC_WITHOUT_HEADER: Track = { header: null, frame: AVC.frame };
const HEVC: Track = { header: null, frame: () => HEVC_FRAME };
const AAC: Track = { header: AAC_SEQUENCE_HEADER, frame: () => AAC_FRAME };
const MP3: Track = { header: null, frame: () => MP3_FRAME };

// 2 秒分の映像 (10 fps) と音声 (48 kHz) のメッセージを、timestamp の順に並べる (同じ時刻なら音声が先。映像は from ミリ秒から)
const stream = (videoTrack: Track | null, audioTrack: Track | null, from = 0): Message[] => {
  const messages: Message[] = [];
  if (audioTrack?.header != null) { messages.push(audio(0, audioTrack.header)); }
  let i = 0;
  for (let t = 0; t < 2000; t += 100) {
    for (; audioTrack != null && aac(i) <= t; i++) { messages.push(audio(aac(i), audioTrack.frame(aac(i)))); }
    if (videoTrack?.header != null && t === from) { messages.push(video(t, videoTrack.header)); }
    if (videoTrack != null && t >= from) { messages.push(video(t, videoTrack.frame(t))); }
  }
  return messages;
};

// メッセージを順に渡して、出力された TS パケットをつなげる
const transmux = (transmuxer: MPEGTSTransmuxer, messages: Message[]): Buffer => {
  return Buffer.concat(messages.flatMap((message) => [... transmuxer.feed(message)]));
};

// TS パケットの PID の一覧
const pids = (ts: Buffer): number[] => {
  return Array.from({ length: ts.byteLength / 188 }, (_, i) => ts.readUInt16BE(i * 188 + 1) & 0x1FFF);
};
// TS パケットに入っている PMT (PID 256) の version_number と、載っている ES の stream_type (0x1B: AVC, 0x0F: AAC) の一覧 (同じ PMT が続く時は 1 つにまとめる)
const pmts = (ts: Buffer): [number, number[]][] => {
  const list: [number, number[]][] = [];
  for (const [index, pid] of pids(ts).entries()) {
    if (pid !== 256) { continue; }
    const packet = ts.subarray(index * 188, (index + 1) * 188);
    const section = packet.subarray(5 + packet[4]); // TS パケットのヘッダ (4 byte) と pointer_field の後ろから
    const version = (section[5] >> 1) & 0x1F; // reserved (2 bit), version_number (5 bit), current_next_indicator (1 bit)
    const end = 3 + (section.readUInt16BE(1) & 0x0FFF) - 4; // CRC_32 の前まで
    const types: number[] = [];
    // program_info の後ろに、ES ごとに stream_type (1 byte), elementary_PID (2 byte), ES_info_length (2 byte), ES_info が並ぶ
    for (let i = 12 + (section.readUInt16BE(10) & 0x0FFF); i < end; i += 5 + (section.readUInt16BE(i + 3) & 0x0FFF)) {
      types.push(section[i]);
    }
    const last = list.at(-1);
    if (last == null || last[0] !== version || last[1].join() !== types.join()) { list.push([version, types]); }
  }
  return list;
};

// 警告のメッセージを記録するロガー
class WarningLogger implements Logger {
  public readonly warnings: string[] = [];
  public trace(): void {}
  public debug(): void {}
  public info(): void {}
  public warn(message: string): void { this.warnings.push(message); }
  public error(): void {}
  public fatal(): void {}
}
const warnings = (run: () => void): string[] => {
  const logger = new WarningLogger();
  registerLogger(logger);
  try { run(); } finally { registerLogger(new NoopLogger()); }
  return logger.warnings;
};

describe('Elementary streams in the PMT', () => {
  // PMT には、データの届く ES だけを載せる (FFmpeg の MPEG-TS と同じ。データの届かない ES まで載せると、mpegts.js などは届かないフレームを待って再生を始めない)
  // (PAT は PID 0、PMT は PID 256、PCR は PID 257、AVC は PID 258、AAC は PID 259)
  test.each<[string, AMF0Object | null, Track | null, Track | null, number[], number[]]>([
    ['H.264 and AAC', { videocodecid: 7, audiocodecid: 10 }, AVC, AAC, [0x1B, 0x0F], [0, 256, 257, 258, 259]],
    // コーデックを数値ではなく 'avc1' や 'mp4a' の文字列で送ってくる配信ソフトもある
    ['H.264 and AAC as strings', { videocodecid: 'avc1', audiocodecid: 'mp4a' }, AVC, AAC, [0x1B, 0x0F], [0, 256, 257, 258, 259]],
    ['audio only (FFmpeg -vn)', { audiocodecid: 10 }, null, AAC, [0x0F], [0, 256, 257, 259]],
    ['video only (FFmpeg -an)', { videocodecid: 7 }, AVC, null, [0x1B], [0, 256, 257, 258]],
    // このサーバでは H.265 や MP3 は MPEG-TS にしないので、映像のない配信や、音声のない配信になる
    ['H.265 + AAC', { videocodecid: HEVC_FOURCC, audiocodecid: 10 }, HEVC, AAC, [0x0F], [0, 256, 257, 259]],
    ['H.264 + MP3', { videocodecid: 7, audiocodecid: 2 }, AVC, MP3, [0x1B], [0, 256, 257, 258]],
    // onMetaData にコーデックが書かれていない時は、届くまで分からないので両方載せる (yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる)
    ['onMetaData without codec ids (yasea)', { width: 320, height: 240, audiosamplerate: 44100, stereo: true }, AVC, AAC, [0x1B, 0x0F], [0, 256, 257, 258, 259]],
    ['no onMetaData', null, AVC, AAC, [0x1B, 0x0F], [0, 256, 257, 258, 259]],
  ])('%s: the PMT lists only the streams that carry data, and never changes', (_, object, videoTrack, audioTrack, types, expected) => {
    const transmuxer = new MPEGTSTransmuxer();
    const ts = transmux(transmuxer, [... (object != null ? [onmetadata(object)] : []), ... stream(videoTrack, audioTrack)]);

    expect(pmts(ts)).toStrictEqual([[0, types]]);
    expect(new Set(pids(ts))).toStrictEqual(new Set(expected));
  });

  test('audio only, then an onMetaData with only the title (a new song): the PMT does not change', () => {
    const transmuxer = new MPEGTSTransmuxer();
    const messages = [onmetadata({ audiocodecid: 10 }), ... stream(null, AAC)];
    // 1 秒のところで、曲名だけを書いた onMetaData が送り直される (PMT に載せる ES は最初の onMetaData で決めるので、映像の ES は載せない)
    messages.splice(messages.findIndex(({ timestamp }) => timestamp >= 1000), 0, onmetadata({ title: 'next' }));
    const ts = transmux(transmuxer, messages);

    expect(pmts(ts)).toStrictEqual([[0, [0x0F]]]);
  });
});

describe('Elementary streams decided from the first video and audio messages', () => {
  // onMetaData にコーデックが書かれていなければ、最初に届いた映像と音声のメッセージで決める (06 の FMP4Transmuxer と同じ)
  // 決まるまでは両方の ES を載せていて、載せる ES が変わったら version_number を 1 増やす (H.222.0 2.4.4.9)
  test('no onMetaData, H.265 + AAC (FFmpeg -flvflags no_metadata): the AVC stream leaves the PMT with the next version_number once the H.265 video arrives', () => {
    const transmuxer = new MPEGTSTransmuxer();
    const ts = transmux(transmuxer, stream(HEVC, AAC));

    // 最初の AAC のフレームは H.265 の映像より先に届くので、その時の PMT にはまだ AVC の ES も載っている
    expect(pmts(ts)).toStrictEqual([[0, [0x1B, 0x0F]], [1, [0x0F]]]);
    expect(pids(ts)).not.toContain(258);
  });

  test('no onMetaData, H.264 + MP3: the AAC stream is not listed when the first audio message is MP3', () => {
    const transmuxer = new MPEGTSTransmuxer();
    const ts = transmux(transmuxer, stream(AVC, MP3));

    expect(pmts(ts)).toStrictEqual([[0, [0x1B]]]);
  });

  test('no onMetaData, MP3 and then AAC: the AAC that arrives later is not output, because the PMT does not list it', () => {
    const transmuxer = new MPEGTSTransmuxer();
    // 2 秒から、音声が MP3 から AAC に変わる
    const ts = transmux(transmuxer, [... stream(AVC, MP3), audio(2000, AAC_SEQUENCE_HEADER), audio(2000, AAC_FRAME), video(2000, AVC.frame(2000)), audio(2021, AAC_FRAME)]);

    expect(pmts(ts)).toStrictEqual([[0, [0x1B]]]);
    expect(pids(ts)).not.toContain(259);
  });

  test('onMetaData without the video, then the AVC video arrives: the AVC stream joins the PMT with the next version_number, before the first video frame', () => {
    const transmuxer = new MPEGTSTransmuxer();
    // onMetaData には書かれていない映像が 1 秒から届く
    const ts = transmux(transmuxer, [onmetadata({ audiocodecid: 10 }), ... stream(AVC, AAC, 1000)]);

    expect(pmts(ts)).toStrictEqual([[0, [0x0F]], [1, [0x1B, 0x0F]]]);
    // 新しい PMT は、PAT/PMT を出力する間隔 (100 ミリ秒) を待たずに、最初の映像のフレームの前に出力する
    const list = pids(ts);
    const before = ts.subarray(0, list.indexOf(258) * 188);
    expect(pmts(before).at(-1)).toStrictEqual([1, [0x1B, 0x0F]]);
  });
});

describe('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier with an encoder without global header)', () => {
  // 中身が空の初期化情報しか届かず、フレームは開始コード付き (Annex B) のまま届くので、その映像は MPEG-TS にできない
  test('with AAC: the video is reported as ignored and the AVC stream leaves the PMT, even if a sequence header arrives later', () => {
    const transmuxer = new MPEGTSTransmuxer();
    const messages = [onmetadata({ videocodecid: 7, audiocodecid: 10 }), video(0, EMPTY_AVC_SEQUENCE_HEADER), ... stream(AVC_WITHOUT_HEADER, AAC)];
    // 1 秒のところで本当の初期化情報が届いても、それより前にフレームが届いた映像は使わない (06 以降のサーバと同じ)
    messages.splice(messages.findIndex(({ timestamp }) => timestamp >= 1000), 0, video(1000, AVC_SEQUENCE_HEADER));
    let ts: Buffer = Buffer.alloc(0);
    expect(warnings(() => { ts = transmux(transmuxer, messages); })).toStrictEqual(['Video sequence header is missing, video is ignored']);

    // 最初の AAC のフレームは最初の映像のフレームより先に届くので、その時の PMT にはまだ AVC の ES も載っている
    expect(pmts(ts)).toStrictEqual([[0, [0x1B, 0x0F]], [1, [0x0F]]]);
    expect(pids(ts)).not.toContain(258);
  });

  test('without audio (FFmpeg -an): the video is reported as ignored and nothing is output', () => {
    const transmuxer = new MPEGTSTransmuxer();
    const messages = [onmetadata({ videocodecid: 7 }), video(0, EMPTY_AVC_SEQUENCE_HEADER), ... stream(AVC_WITHOUT_HEADER, null)];
    let ts: Buffer = Buffer.alloc(0);
    expect(warnings(() => { ts = transmux(transmuxer, messages); })).toStrictEqual(['Video sequence header is missing, video is ignored']);

    expect(ts.byteLength).toStrictEqual(0);
  });
});

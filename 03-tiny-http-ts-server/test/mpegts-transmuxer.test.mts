import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import type { Logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import MPEGTSTransmuxer from '../src/mpegts-transmuxer.mts';
import DecisionWait, { DECISION_WAIT, MAX_PENDING_MESSAGES } from '../src/decision-wait.mts';

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
// 従来の形式の Sorenson H.263 (CodecID 2) のフレーム (このサーバでは扱わない)
const SORENSON_FRAME = Buffer.from('1200008400', 'hex');
// FFmpeg 8.0 以降が 2 つ目の映像トラックを送る、Enhanced RTMP の Multitrack (PacketType 6) の形式の H.264 のフレーム (このサーバでは扱わない)
// (ExVideoTagHeader の 1 byte の後に、AvMultitrackType (OneTrack は 0) と PacketType (1 は CodedFrames) の 1 byte, 'avc1', トラック番号 1 が続く)
const SECOND_TRACK_FRAME = Buffer.from('96016176633101000000', 'hex');

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
const SORENSON: Track = { header: null, frame: () => SORENSON_FRAME };
const AAC: Track = { header: AAC_SEQUENCE_HEADER, frame: () => AAC_FRAME };
const MP3: Track = { header: null, frame: () => MP3_FRAME };

// 2 秒分の映像 (10 fps) と音声 (48 kHz) のメッセージを、timestamp の順に並べる (同じ時刻なら音声が先。映像は videoFrom ミリ秒から、音声は audioFrom ミリ秒から)
const stream = (videoTrack: Track | null, audioTrack: Track | null, videoFrom = 0, audioFrom = 0): Message[] => {
  const messages: Message[] = [];
  let i = 0;
  for (let t = 0; t < 2000; t += 100) {
    for (; audioTrack != null && aac(i) <= t; i++) {
      if (aac(i) < audioFrom) { continue; }
      // 1 つ前のフレームが audioFrom より前なら、これが最初のフレーム
      if (audioTrack.header != null && aac(i - 1) < audioFrom) { messages.push(audio(aac(i), audioTrack.header)); }
      messages.push(audio(aac(i), audioTrack.frame(aac(i))));
    }
    if (videoTrack?.header != null && t === videoFrom) { messages.push(video(t, videoTrack.header)); }
    if (videoTrack != null && t >= videoFrom) { messages.push(video(t, videoTrack.frame(t))); }
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
    // このサーバでは H.265 や Sorenson H.263 や MP3 は MPEG-TS にしないので、映像のない配信や、音声のない配信になる
    ['H.265 + AAC', { videocodecid: HEVC_FOURCC, audiocodecid: 10 }, HEVC, AAC, [0x0F], [0, 256, 257, 259]],
    // FFmpeg の -f flv は、映像のコーデックを指定しないと Sorenson H.263 になる (従来の形式でも、CodecID が 7 でなければ H.264 ではない)
    ['Sorenson H.263 + AAC (FFmpeg -f flv without -c:v)', { videocodecid: 2, audiocodecid: 10 }, SORENSON, AAC, [0x0F], [0, 256, 257, 259]],
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

  // それぞれのトラックの初期化情報を、そのトラックの最初のフレームの直前に送ってくる配信ソフト (yasea など) では、音声が映像より後から届くこともある
  // 音声が届く前の PMT にも、onMetaData に書かれた AAC (コーデックが書かれていなければ、届くかもしれない AAC) を載せておくので、音声が届いても PMT は変わらない
  test.each<[string, AMF0Object | null]>([
    ['H.264 and AAC', { videocodecid: 7, audiocodecid: 10 }],
    ['H.264 and AAC as strings', { videocodecid: 'avc1', audiocodecid: 'mp4a' }],
    ['onMetaData without codec ids (yasea)', { width: 320, height: 240, audiosamplerate: 44100, stereo: true }],
    ['no onMetaData', null],
  ])('%s, the audio arrives after the first video frames: the PMT lists the AAC stream from the start, and never changes', (_, object) => {
    const transmuxer = new MPEGTSTransmuxer();
    // 音声 (と、その初期化情報) は 1 秒から届く
    const ts = transmux(transmuxer, [... (object != null ? [onmetadata(object)] : []), ... stream(AVC, AAC, 0, 1000)]);

    expect(pmts(ts)).toStrictEqual([[0, [0x1B, 0x0F]]]);
    expect(new Set(pids(ts))).toStrictEqual(new Set([0, 256, 257, 258, 259]));
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
  // 決まるまでは届くかもしれない ES も載せておき、載せないと分かったら外して version_number を 1 増やす (H.222.0 2.4.4.9)
  // (載せずに PMT を出力した ES は、後からそのトラックが届いても載せない)
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

  test('H.264 + AAC with a second video track (FFmpeg 8.0 or later): the frames of the second track in the Multitrack format do not change the PMT', () => {
    const transmuxer = new MPEGTSTransmuxer();
    // 1 つ目の映像トラックは従来の形式で届くので、映像は H.264 に決まり、後から届く 2 つ目のトラックのフレームでは変わらない (2 つ目のトラックは使わない)
    const messages = stream(AVC, AAC).flatMap((message) => message.message_type_id === MessageType.Video ? [message, video(message.timestamp, SECOND_TRACK_FRAME)] : [message]);
    const ts = transmux(transmuxer, [onmetadata({ videocodecid: 7, audiocodecid: 10 }), ... messages]);

    expect(pmts(ts)).toStrictEqual([[0, [0x1B, 0x0F]]]);
    expect(new Set(pids(ts))).toStrictEqual(new Set([0, 256, 257, 258, 259]));
  });

  // 載せずに PMT を出力した ES は、後からそのトラックが届いても載せない (FFmpeg も、出力を始めた後から届いたトラックは使わない。06 以降の初期化セグメントと同じ)
  // (MSE で再生するプレイヤー (mpegts.js など) は、再生を始めた後からトラックを増やせない)
  test('onMetaData without the video, then the AVC video arrives: the AVC stream does not join the PMT and the video is not output', () => {
    const transmuxer = new MPEGTSTransmuxer();
    // onMetaData には書かれていない映像が 1 秒から届く
    const ts = transmux(transmuxer, [onmetadata({ audiocodecid: 10 }), ... stream(AVC, AAC, 1000)]);

    expect(pmts(ts)).toStrictEqual([[0, [0x0F]]]);
    expect(pids(ts)).not.toContain(258);
  });

  test('onMetaData without the audio, then the AAC audio arrives: the AAC stream does not join the PMT and the audio is not output', () => {
    const transmuxer = new MPEGTSTransmuxer();
    // onMetaData には書かれていない音声 (と、その初期化情報) が 1 秒から届く
    const ts = transmux(transmuxer, [onmetadata({ videocodecid: 7 }), ... stream(AVC, AAC, 0, 1000)]);

    expect(pmts(ts)).toStrictEqual([[0, [0x1B]]]);
    expect(pids(ts)).not.toContain(259);
  });
});

describe('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier with an encoder without global header)', () => {
  // 中身が空の初期化情報しか届かず、フレームは開始コード付き (Annex B) のまま届く (このサーバはフレームを長さ付きの NAL Unit として読むので、その映像は使わない)
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

describe('Waiting until the elementary streams in the PMT are decided (HTTP-TS server)', () => {
  // HTTP-TS 配信 (index.mts) と同じく、PMT に載せる ES が決まるまで DecisionWait で待ってから TS パケットにする
  // (配信が終わったら、決まっていなくても取り出す)
  const transmux_after_decided = (transmuxer: MPEGTSTransmuxer, messages: Message[]): Buffer => {
    const wait = new DecisionWait(transmuxer);
    const packets = messages.flatMap((message) => wait.feed(message).packets);
    return Buffer.concat([... packets, ... wait.flush().packets]);
  };
  // メッセージを順に DecisionWait に渡して、待っていた間の分をまとめて返したメッセージの番号を返す (返さなければ null)
  const released = (wait: DecisionWait, messages: Message[]): number | null => {
    for (const [index, message] of messages.entries()) {
      if (wait.feed(message).released) { return index; }
    }
    return null;
  };

  test('H.264 and AAC: decided by the sequence headers, before the first frame', () => {
    const transmuxer = new MPEGTSTransmuxer();
    transmuxer.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    expect(transmuxer.decided()).toStrictEqual(false);
    transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER));
    expect(transmuxer.decided()).toStrictEqual(true);
  });

  // onMetaData に書かれていないトラックは待たない。音声は最初の音声のメッセージで決まる (中身が空の AAC の初期化情報でもよい: 本当の初期化情報が届くのを待たない)
  test.each<[string, AMF0Object, Message[]]>([
    ['audio only (FFmpeg -vn)', { audiocodecid: 10 }, [audio(0, AAC_SEQUENCE_HEADER)]],
    ['video only (FFmpeg -an)', { videocodecid: 7 }, [video(0, AVC_SEQUENCE_HEADER)]],
    ['H.264 and AAC, an empty AAC sequence header first (FFmpeg -c copy from ADTS AAC)', { videocodecid: 7, audiocodecid: 10 }, [video(0, AVC_SEQUENCE_HEADER), audio(0, Buffer.from('af00', 'hex'))]],
  ])('%s: decided by the sequence headers, before the first frame', (_, object, messages) => {
    const transmuxer = new MPEGTSTransmuxer();
    transmuxer.feed(onmetadata(object));
    for (const message of messages) { transmuxer.feed(message); }
    expect(transmuxer.decided()).toStrictEqual(true);
  });

  // FFmpeg が送ってくる順で、最初の映像か音声のフレームより後に ES が決まる配信 (同じ時刻なら映像が先)
  test.each<[string, Message[], [number, number[]][], [number, number[]][]]>([
    // B フレームのある H.264 と MP3 を FFmpeg -flvflags no_metadata で送ると、最初の MP3 のフレームは映像のフレームより後に届く
    // (FFmpeg は映像の DTS が負にならないように全体を遅らせる。B フレームがなければ MP3 が先に届くので、待たなくても AAC の ES は載らない)
    ['no onMetaData, H.264 + MP3', [video(0, AVC_SEQUENCE_HEADER), video(0, avc(1)), video(33, avc(2)), audio(42, MP3_FRAME), video(67, avc(2)), audio(68, MP3_FRAME)], [[0, [0x1B, 0x0F]], [1, [0x1B]]], [[0, [0x1B]]]],
    // FFmpeg 6.0 以前で初期化情報を出さないエンコーダ (B フレームなし) の H.264 と AAC を送ると、最初の AAC のフレームは映像のフレームより先に届く
    ['H.264 whose real sequence header never arrives, with AAC', [onmetadata({ videocodecid: 7, audiocodecid: 10 }), video(0, EMPTY_AVC_SEQUENCE_HEADER), audio(0, AAC_SEQUENCE_HEADER), audio(0, AAC_FRAME), video(21, avc(1)), audio(21, AAC_FRAME)], [[0, [0x1B, 0x0F]], [1, [0x0F]]], [[0, [0x0F]]]],
    // FFmpeg -flvflags no_metadata で Sorenson H.263 + AAC を送ると、最初の AAC のフレームは映像のフレームより先に届く
    ['no onMetaData, Sorenson H.263 + AAC', [audio(0, AAC_SEQUENCE_HEADER), audio(0, AAC_FRAME), video(21, SORENSON_FRAME), audio(21, AAC_FRAME)], [[0, [0x1B, 0x0F]], [1, [0x0F]]], [[0, [0x0F]]]],
  ])('%s: the first PMT lists only the streams that carry data when the output waits until they are decided', (_, messages, immediate, waited) => {
    // 待たずに出力すると、最初の PMT には後から載せないと分かった ES も載っている (mpegts.js などは、PMT が変わってもその ES のデータを待って再生を始めない)
    expect(pmts(transmux(new MPEGTSTransmuxer(), messages))).toStrictEqual(immediate);
    const transmuxer = new MPEGTSTransmuxer();
    expect(pmts(transmux_after_decided(transmuxer, messages))).toStrictEqual(waited);
    // 配信が終わるのを待たずに、最初の映像と音声のメッセージが揃った所で決まる
    expect(transmuxer.decided()).toStrictEqual(true);
  });

  test('no onMetaData and no audio: never decided (the HTTP-TS server stops waiting after a while)', () => {
    const transmuxer = new MPEGTSTransmuxer();
    transmux(transmuxer, stream(AVC, null));
    expect(transmuxer.decided()).toStrictEqual(false);
  });

  test('H.264 and AAC (FFmpeg): released at the sequence headers, and the frames after them are not held', () => {
    const wait = new DecisionWait(new MPEGTSTransmuxer());
    expect(wait.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }))).toStrictEqual({ packets: [], released: false });
    expect(wait.feed(video(0, AVC_SEQUENCE_HEADER))).toStrictEqual({ packets: [], released: false });
    // 初期化情報は TS パケットにならないので、まとめて返すものはまだない
    expect(wait.feed(audio(0, AAC_SEQUENCE_HEADER))).toStrictEqual({ packets: [], released: true });
    // 最初のフレームから、PAT と、映像と音声の ES を載せた PMT を付けてすぐに返す
    const { packets, released } = wait.feed(video(0, avc(1)));
    expect(released).toStrictEqual(false);
    expect(pids(Buffer.concat(packets)).slice(0, 2)).toStrictEqual([0, 256]);
    expect(pmts(Buffer.concat(packets))).toStrictEqual([[0, [0x1B, 0x0F]]]);
  });

  test('never decided (onMetaData without codec ids, no audio): released after DECISION_WAIT of video timestamps, measured from the first video message and not from the onMetaData', () => {
    const wait = new DecisionWait(new MPEGTSTransmuxer());
    // コーデックの書かれていない onMetaData (timestamp は 0) の後に、5 秒から映像だけが届く (音声が届くかもしれないので、決まらない)
    const messages = [onmetadata({ width: 320, height: 240 }), ... stream(AVC, null).map((message) => ({ ... message, timestamp: message.timestamp + 5000 }))];
    // 最初の映像のメッセージから DECISION_WAIT たったメッセージで、それまで溜めていた分をまとめて返す
    expect(released(wait, messages)).toStrictEqual(messages.findIndex((message) => message.timestamp === 5000 + DECISION_WAIT));
  });

  test('never decided, with timestamps that do not advance: released when MAX_PENDING_MESSAGES messages are held', () => {
    const wait = new DecisionWait(new MPEGTSTransmuxer());
    const messages = [video(0, AVC_SEQUENCE_HEADER), ... Array.from({ length: MAX_PENDING_MESSAGES * 2 }, () => video(0, avc(1)))];
    expect(released(wait, messages)).toStrictEqual(MAX_PENDING_MESSAGES - 1);
  });

  test('the stream ends before it is decided: flush returns every held packet in order, from the PAT and the PMT', () => {
    const wait = new DecisionWait(new MPEGTSTransmuxer());
    // 0.5 秒で終わる、onMetaData のない映像だけの配信 (FFmpeg -an -flvflags no_metadata)
    const messages = stream(AVC, null).filter((message) => message.timestamp < 500);
    expect(released(wait, messages)).toBeNull();
    const { packets, released: flushed } = wait.flush();
    expect(flushed).toStrictEqual(true);
    const ts = Buffer.concat(packets);
    expect(pids(ts).slice(0, 2)).toStrictEqual([0, 256]);
    // 溜めていた 5 フレームの映像が全て入っている (feed が返したまま、待たずに TS パケットにしたものと同じ)
    expect(ts).toStrictEqual(transmux(new MPEGTSTransmuxer(), messages));
  });
});

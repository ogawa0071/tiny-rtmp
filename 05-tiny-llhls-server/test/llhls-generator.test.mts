import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import type { Logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import LLHLSGenerator from '../src/llhls-generator.mts';

// FFmpeg が送ってくる AVC と AAC の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
const AAC_FRAME = Buffer.from('af0121', 'hex');
// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム)
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
// FFmpeg が、まだ初期化情報がない時に送ってくる中身が空の AVC の初期化情報
const EMPTY_AVC_SEQUENCE_HEADER = Buffer.from('1700000000', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// 48 kHz の AAC (1 フレーム 1024 サンプル) の i 番目のフレームの timestamp (ミリ秒に丸める)
const aac = (i: number): number => Math.round(i * 1024 * 1000 / 48000);

// プレイリストに載っている (完成した) セグメントの長さ (秒)
const extinfs = (generator: LLHLSGenerator): number[] => {
  return [... generator.m3u8().matchAll(/#EXTINF:([0-9.]+),/g)].map((match) => Number.parseFloat(match[1]));
};

// プレイリストに載っているパーシャルセグメントの EXT-X-PART タグ
const parts = (generator: LLHLSGenerator): string[] => {
  return generator.m3u8().split('\n').filter((line) => line.startsWith('#EXT-X-PART:'));
};

// プレイリストに載っている (完成した) セグメントと、パーシャルセグメント
const segments = (generator: LLHLSGenerator): Promise<Buffer[]> => {
  return Promise.all([... generator.m3u8().matchAll(/^(\d+)\.ts$/gm)].map(async ([, msn]) => (await generator.get(Number(msn), null))!));
};
const partialSegments = (generator: LLHLSGenerator): Promise<[string, Buffer][]> => {
  return Promise.all([... generator.m3u8().matchAll(/^#EXT-X-PART:.*URI="(\d+)_(\d+)\.ts"/gm)].map(async ([, msn, part]) => [`${msn}_${part}`, (await generator.get(Number(msn), Number(part)))!] as [string, Buffer]));
};

// TS パケットの PID の一覧
const pids = (segment: Buffer): number[] => {
  return Array.from({ length: segment.byteLength / 188 }, (_, i) => segment.readUInt16BE(i * 188 + 1) & 0x1FFF);
};
// セグメントに入っている PMT (PID 256) の version_number と、載っている ES の stream_type (0x1B: AVC, 0x0F: AAC) の一覧
const pmts = (segment: Buffer): [number, number[]][] => {
  return pids(segment).flatMap((pid, index) => {
    if (pid !== 256) { return []; }
    const packet = segment.subarray(index * 188, (index + 1) * 188);
    const section = packet.subarray(5 + packet[4]); // TS パケットのヘッダ (4 byte) と pointer_field の後ろから
    const version = (section[5] >> 1) & 0x1F; // reserved (2 bit), version_number (5 bit), current_next_indicator (1 bit)
    const end = 3 + (section.readUInt16BE(1) & 0x0FFF) - 4; // CRC_32 の前まで
    const types: number[] = [];
    // program_info の後ろに、ES ごとに stream_type (1 byte), elementary_PID (2 byte), ES_info_length (2 byte), ES_info が並ぶ
    for (let i = 12 + (section.readUInt16BE(10) & 0x0FFF); i < end; i += 5 + (section.readUInt16BE(i + 3) & 0x0FFF)) {
      types.push(section[i]);
    }
    return [[version, types] as [number, number[]]];
  });
};
// セグメントの最初の PMT に載っている ES の stream_type の一覧
const streamTypes = (segment: Buffer): number[] => pmts(segment)[0][1];
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

// 映像 (PID 258) と音声 (PID 259) の PES の PTS を、TS パケットの順に並べたもの (PES の先頭の TS パケット (payload_unit_start_indicator が 1 のもの) から読む)
const pts = (segment: Buffer): number[] => {
  return pids(segment).flatMap((pid, i) => {
    const packet = segment.subarray(i * 188, (i + 1) * 188);
    if ((pid !== 258 && pid !== 259) || (packet[1] & 0x40) === 0) { return []; }
    // adaptation_field があれば、その後ろから PES が始まる
    const pes = packet.subarray((packet[3] & 0x20) !== 0 ? 5 + packet[4] : 4);
    // PES のヘッダ (9 byte) の後ろの PTS (33 bit を 3, 15, 15 bit に分けて、それぞれの後ろに marker_bit を置いてある)
    return [((pes[9] >> 1) & 0x07) * 2 ** 30 + (pes.readUInt16BE(10) >> 1) * 2 ** 15 + (pes.readUInt16BE(12) >> 1)];
  });
};

describe('Streams without video', () => {
  test('audio only (FFmpeg -vn): segments and partial segments are cut at the AAC frames, and the playlist is published', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata({ audiocodecid: 10, audiosamplerate: 48000, stereo: true }));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let i = 0; aac(i) < 4500; i++) {
      generator.feed(audio(aac(i), AAC_FRAME));
    }

    expect(await generator.published()).toStrictEqual(true);
    // 1 秒以上たってから最初の AAC のフレームでセグメントを区切る (フレームは 1024 / 48000 秒ごとなので、1 秒より少し長くなる)
    // (最初のセグメントは、4 つ目のセグメントができた時にライブウィンドウから外れている)
    expect(extinfs(generator)).toStrictEqual([1.002, 1.003, 1.003]);
    // AAC のフレームはどれも単体でデコードできるので、どのパーシャルセグメントも INDEPENDENT=YES にする
    expect(parts(generator).length).toBeGreaterThan(0);
    expect(parts(generator).every((part) => part.endsWith(',INDEPENDENT=YES'))).toStrictEqual(true);
    for (const segment of await segments(generator)) {
      // セグメントは PAT/PMT から始まり、PAT/PMT はパーシャルセグメントの先頭と 100 ミリ秒ごとに入れる (AAC のフレームごとには入れない)
      expect(pids(segment).slice(0, 2)).toStrictEqual([0, 256]);
      expect(pids(segment).filter((pid) => pid === 0).length).toBeLessThanOrEqual(14);
      // PMT には AAC の ES だけを載せる (データの届かない AVC の ES まで載せると、届かない映像のフレームを待ってしまうプレイヤーがある)
      expect(streamTypes(segment)).toStrictEqual([0x0F]);
    }
  });

  // どのパーシャルセグメントからでもデコードを始められるように、パーシャルセグメントの先頭は PAT と PMT にする (RFC 8216bis 3.2, 3.1.1)
  // (--partDuration 0.5 や 1 では、セグメントの最後のパーシャルセグメントが AAC の 1 フレーム (約 21 ミリ秒) だけになり、100 ミリ秒ごとの PAT/PMT が入らないこともある)
  test.each([0.25, 0.3, 0.5, 1])('audio only, --partDuration %s: every partial segment starts with PAT and PMT', async (partialSegmentDuration) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration });
    generator.feed(onmetadata({ audiocodecid: 10, audiosamplerate: 48000, stereo: true }));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let i = 0; aac(i) < 4500; i++) {
      generator.feed(audio(aac(i), AAC_FRAME));
    }

    expect(await generator.published()).toStrictEqual(true);
    const list = await partialSegments(generator);
    expect(list.length).toBeGreaterThan(0);
    for (const [name, data] of list) {
      expect(pids(data).slice(0, 2), name).toStrictEqual([0, 256]);
    }
  });
});

describe('Streams with video', () => {
  test.each([
    // コーデックを数値ではなく 'avc1' や 'mp4a' の文字列で送ってくる配信ソフトもある
    ['onMetaData with AVC and AAC as strings', { videocodecid: 'avc1', audiocodecid: 'mp4a' }],
    // yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる
    ['onMetaData without codec ids (yasea)', { width: 320, height: 240, audiosamplerate: 44100, stereo: true }],
  ])('%s: segments start from the keyframes even when the video starts after the audio', (_, object) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata(object));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 映像 (10 fps、2 秒ごとにキーフレーム) は音声より 2 秒遅れて届く
    let i = 0;
    for (let t = 0; t < 9000; t += 100) {
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      if (t === 2000) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 2000) { generator.feed(video(t, avc(t % 2000 === 0 ? 1 : 2))); }
    }

    // 音声だけのセグメントは作らない (最初のセグメントは 2 秒のキーフレームから)
    expect(extinfs(generator)).toStrictEqual([2, 2, 2]);
  });

  test('onMetaData without the video: the AVC video that arrives later is not used, and segments are cut at the AAC frames', async () => {
    // 区切ったセグメントが全てプレイリストに残るように、ライブウィンドウを長くする
    const generator = new LLHLSGenerator({ liveWindowLength: 10, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata({ audiocodecid: 10 }));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // onMetaData には書かれていない映像 (10 fps、1 秒ごとにキーフレーム) が 2.5 秒から届く
    let i = 0;
    for (let t = 0; t < 7000; t += 100) {
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      if (t === 2500) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 2500) { generator.feed(video(t, avc((t - 2500) % 1000 === 0 ? 1 : 2))); }
    }

    // HLS (04-tiny-hls-server) と同じく、映像は音声を TS パケットにし始めた後から届いたので使わず、最後まで AAC のフレームで区切る
    expect(extinfs(generator)).toStrictEqual([1.003, 1.002, 1.003, 1.003, 1.002, 1.003]);
    // PMT は変わらず (AAC の ES だけ)、映像は出力しない
    const changes = (await segments(generator)).flatMap(pmts).filter(([version, types], index, list) => index === 0 || version !== list[index - 1][0] || types.join() !== list[index - 1][1].join());
    expect(changes).toStrictEqual([[0, [0x0F]]]);
    expect((await segments(generator)).flatMap(pids)).not.toContain(258);
  });

  // キーフレームの間隔が 1 秒より短い配信では、セグメントの途中のキーフレームを含むパーシャルセグメントも INDEPENDENT=YES になる
  // (この配信では、6 フレームごとのキーフレームからパーシャルセグメントが始まる。キーフレームがパーシャルセグメントの途中にあることもある: 下の 30 fps の例)
  // そこからデコードを始められるように、どのパーシャルセグメントも PAT と PMT から始める (RFC 8216bis 3.2, 3.1.1)
  test('keyframes every 0.25 s: every partial segment starts with PAT and PMT', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.25 });
    generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 24 fps の映像 (6 フレームごとにキーフレーム) と 48 kHz の AAC
    let i = 0;
    for (let frame = 0; frame < 24 * 5; frame++) {
      const t = Math.round(frame * 1000 / 24);
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      generator.feed(video(t, avc(frame % 6 === 0 ? 1 : 2)));
    }

    expect(await generator.published()).toStrictEqual(true);
    // セグメントの途中のキーフレームから始まる INDEPENDENT=YES のパーシャルセグメントがある
    expect(parts(generator).filter((part) => !/_0\.ts"/.test(part) && part.endsWith(',INDEPENDENT=YES')).length).toBeGreaterThan(0);
    const list = await partialSegments(generator);
    for (const [name, data] of list) {
      expect(pids(data).slice(0, 2), name).toStrictEqual([0, 256]);
    }
    // PMT には AVC と AAC の ES を載せる
    for (const segment of await segments(generator)) {
      expect(streamTypes(segment)).toStrictEqual([0x1B, 0x0F]);
    }
  });
});

describe('Partial segments in the middle of a GOP', () => {
  // パーシャルセグメントの多くは、セグメントの途中の (キーフレームではない) フレームから始まる
  // そのパーシャルセグメントも PAT と PMT から始まるように、フレームとその後に届いた音声は、どのパーシャルセグメントに入れるかを決めてから、届いた順に TS パケットにする
  // (決める前に TS パケットにすると PAT/PMT がパーシャルセグメントの途中に入り、届いた順に TS パケットにしないと時刻が戻る)
  test('29.97 fps, 2 s GOP: every partial segment starts with PAT and PMT, and keeps the video and audio in the order they arrived', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 29.97 fps の映像 (60 フレームごとにキーフレーム) と 48 kHz の AAC
    let i = 0;
    for (let frame = 0; frame < 60 * 5; frame++) {
      const t = Math.round(frame * 1001 / 30);
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      generator.feed(video(t, avc(frame % 60 === 0 ? 1 : 2)));
    }

    expect(await generator.published()).toStrictEqual(true);
    // キーフレームを含まない (INDEPENDENT=YES ではない) パーシャルセグメントがある
    expect(parts(generator).filter((part) => !part.endsWith(',INDEPENDENT=YES')).length).toBeGreaterThan(0);
    for (const [name, data] of await partialSegments(generator)) {
      expect(pids(data).slice(0, 2), name).toStrictEqual([0, 256]);
      // 映像と音声は timestamp の順に届くので、届いた順に TS パケットにしていれば PTS も順に並ぶ (この映像には B フレームがないので、PTS は DTS と同じ)
      expect(pts(data), name).toStrictEqual(pts(data).toSorted((a, b) => a - b));
    }
  });

  // HLS (04-tiny-hls-server) と同じく、パーシャルセグメントの途中のキーフレームの前にも PAT と PMT を入れる
  test('keyframes inside a partial segment also get PAT and PMT in front of them', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 10, partialSegmentDuration: 0.25 });
    generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 30 fps の映像 (0.5 秒ごとにキーフレーム) と 48 kHz の AAC
    // パーシャルセグメントは 7 フレーム (約 0.233 秒) ずつで区切るので、0.5 秒のキーフレーム (15 番のフレーム) は 14 番のフレームから始まるパーシャルセグメントの途中にある
    let i = 0;
    for (let frame = 0; frame < 30 * 8; frame++) {
      const t = Math.round(frame * 1000 / 30);
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      generator.feed(video(t, avc(frame % 15 === 0 ? 1 : 2)));
    }
    generator.end();

    const stream = Buffer.concat(await segments(generator));
    const list = pids(stream);
    // 映像の PES の始まり (payload_unit_start_indicator が立っている TS パケット) と、そのうちキーフレームのもの (15 フレームごと)
    const frames = list.flatMap((pid, index) => pid === 258 && (stream[index * 188 + 1] & 0x40) !== 0 ? [index] : []);
    const keyframes = frames.filter((_, n) => n % 15 === 0);
    expect(keyframes.length).toStrictEqual(16);
    // どのキーフレームも、1 つ前の映像のフレームより後に PAT がある
    for (const index of keyframes) {
      const before = list.slice(0, index);
      expect(before.lastIndexOf(0)).toBeGreaterThan(before.lastIndexOf(258));
    }
  });
});

describe('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier with an encoder without global header)', () => {
  // HLS (04-tiny-hls-server) と同じく、その映像は使わずに、映像のない配信として扱う
  test.each([
    ['with AAC', 0],
    // B フレームがあると、最初の AAC のフレームは最初のキーフレームより後に届く (HLS (04-tiny-hls-server) と同じく、使わないキーフレームからはセグメントを始めない)
    ['with AAC starting 44 ms after the first keyframe (FFmpeg with B-frames)', 44],
  ])('%s: the video is reported as ignored, and every partial segment is cut at the AAC frames with a PMT that lists only AAC', async (_, delay) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    expect(warnings(() => {
      generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
      generator.feed(video(0, EMPTY_AVC_SEQUENCE_HEADER));
      generator.feed(audio(0, AAC_SEQUENCE_HEADER));
      // 10 fps の映像 (1 秒ごとにキーフレーム) と、delay ミリ秒から始まる AAC
      let i = 0;
      for (let t = 0; t < 4500; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        for (; delay + aac(i) < t + 100; i++) { generator.feed(audio(delay + aac(i), AAC_FRAME)); }
      }
    })).toStrictEqual(['Video sequence header is missing, video is ignored']);

    expect(await generator.published()).toStrictEqual(true);
    // 音声だけの配信と同じく、最初の AAC のフレームから始めて AAC のフレームで区切り、どのパーシャルセグメントも INDEPENDENT=YES にする
    expect(extinfs(generator)).toStrictEqual([1.002, 1.003, 1.003]);
    expect(parts(generator).every((part) => part.endsWith(',INDEPENDENT=YES'))).toStrictEqual(true);
    for (const [name, data] of await partialSegments(generator)) {
      expect(pids(data).slice(0, 2), name).toStrictEqual([0, 256]);
      expect(streamTypes(data), name).toStrictEqual([0x0F]);
      expect(pids(data), name).not.toContain(258);
    }
  });
});

describe('RTMP timestamps that wrap around', () => {
  test.each([
    ['the RTMP specification (32bit)', 2 ** 32],
    ['FFmpeg (31bit)', 2 ** 31],
  ])('segments and partial segments keep being made after the timestamps of %s wrap around', (_, wrap) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    // 配信を始めてから 2.5 秒後に timestamp が一周して 0 に戻る
    const timestamp = (t: number): number => (wrap - 2500 + t) % wrap;
    generator.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
    generator.feed(audio(timestamp(0), AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 6000; t += 100) {
      generator.feed(video(timestamp(t), avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(timestamp(t + 8), AAC_FRAME));
    }
    // 一周した後も 1 秒ごとのキーフレームからセグメントができ (プレイリストには、一周した 2.5 秒を含むセグメントから 3 つが載る)、
    // パーシャルセグメントも 3 フレーム (0.3 秒) ごとに区切られる (最後の 3 つは作成中のセグメントのもの)
    expect(extinfs(generator)).toStrictEqual([1, 1, 1]);
    const durations = parts(generator).map((part) => Number(/DURATION=([\d.]+)/.exec(part)![1]));
    expect(durations).toStrictEqual([0.3, 0.3, 0.3, 0.1, 0.3, 0.3, 0.3, 0.1, 0.3, 0.3, 0.3, 0.1, 0.3, 0.3, 0.3]);
  });
});

describe('Malformed messages', () => {
  // TS パケットにするのはパーシャルセグメントが決まるまで待つが、壊れたデータの例外は、そのメッセージの feed で起きる
  // (index.mts は feed の例外を記録して配信を終える。配信の終わりに finally の中で呼ぶ end で例外が起きると、サーバごと落ちてしまう)
  test.each([
    ['a coded frame whose NAL unit is shorter than its length', video(5000, Buffer.from('27010000000000000541', 'hex'))],
    ['an AVC sequence header that is too short', video(5000, Buffer.from('17000000000142', 'hex'))],
    ['an AAC sequence header that is too short', audio(5000, Buffer.from('af0012', 'hex'))],
  ])('%s as the last message: feed throws, and end completes the playlist without throwing', async (_, malformed) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 5000; t += 100) {
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(t + 8, AAC_FRAME));
    }

    expect(() => { generator.feed(malformed); }).toThrow();
    expect(() => { generator.end(); }).not.toThrow();
    // 最後のセグメントも完成して、プレイリストを公開できる
    expect(await generator.published()).toStrictEqual(true);
    expect(generator.m3u8()).toContain('#EXT-X-ENDLIST');
    expect(extinfs(generator)).toStrictEqual([1, 1, 1]);
  });
});

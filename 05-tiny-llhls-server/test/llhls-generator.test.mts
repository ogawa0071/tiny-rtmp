import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import type { Logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import LLHLSGenerator from '../src/llhls-generator.mts';

const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
const AAC_FRAME = Buffer.from('af0121', 'hex');
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const EMPTY_AVC_SEQUENCE_HEADER = Buffer.from('1700000000', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

const aac = (i: number): number => Math.round(i * 1024 * 1000 / 48000);

const extinfs = (generator: LLHLSGenerator): number[] => {
  return [... generator.m3u8().matchAll(/#EXTINF:([0-9.]+),/g)].map((match) => Number.parseFloat(match[1]));
};

const parts = (generator: LLHLSGenerator): string[] => {
  return generator.m3u8().split('\n').filter((line) => line.startsWith('#EXT-X-PART:'));
};

const segments = (generator: LLHLSGenerator): Promise<Buffer[]> => {
  return Promise.all([... generator.m3u8().matchAll(/^(\d+)\.ts$/gm)].map(async ([, msn]) => (await generator.get(Number(msn), null))!));
};
const partialSegments = (generator: LLHLSGenerator): Promise<[string, Buffer][]> => {
  return Promise.all([... generator.m3u8().matchAll(/^#EXT-X-PART:.*URI="(\d+)_(\d+)\.ts"/gm)].map(async ([, msn, part]) => [`${msn}_${part}`, (await generator.get(Number(msn), Number(part)))!] as [string, Buffer]));
};

const pids = (segment: Buffer): number[] => {
  return Array.from({ length: segment.byteLength / 188 }, (_, i) => segment.readUInt16BE(i * 188 + 1) & 0x1FFF);
};
const pmts = (segment: Buffer): [number, number[]][] => {
  return pids(segment).flatMap((pid, index) => {
    if (pid !== 256) { return []; }
    const packet = segment.subarray(index * 188, (index + 1) * 188);
    const section = packet.subarray(5 + packet[4]);
    const version = (section[5] >> 1) & 0x1F;
    const end = 3 + (section.readUInt16BE(1) & 0x0FFF) - 4;
    const types: number[] = [];
    for (let i = 12 + (section.readUInt16BE(10) & 0x0FFF); i < end; i += 5 + (section.readUInt16BE(i + 3) & 0x0FFF)) {
      types.push(section[i]);
    }
    return [[version, types] as [number, number[]]];
  });
};
const streamTypes = (segment: Buffer): number[] => pmts(segment)[0][1];
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

const pts = (segment: Buffer): number[] => {
  return pids(segment).flatMap((pid, i) => {
    const packet = segment.subarray(i * 188, (i + 1) * 188);
    if ((pid !== 258 && pid !== 259) || (packet[1] & 0x40) === 0) { return []; }
    const pes = packet.subarray((packet[3] & 0x20) !== 0 ? 5 + packet[4] : 4);
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
    expect(extinfs(generator)).toStrictEqual([1.002, 1.003, 1.003]);
    expect(parts(generator).length).toBeGreaterThan(0);
    expect(parts(generator).every((part) => part.endsWith(',INDEPENDENT=YES'))).toStrictEqual(true);
    for (const segment of await segments(generator)) {
      expect(pids(segment).slice(0, 2)).toStrictEqual([0, 256]);
      expect(pids(segment).filter((pid) => pid === 0).length).toBeLessThanOrEqual(14);
      expect(streamTypes(segment)).toStrictEqual([0x0F]);
    }
  });

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
    ['onMetaData with AVC and AAC as strings', { videocodecid: 'avc1', audiocodecid: 'mp4a' }],
    ['onMetaData without codec ids (yasea)', { width: 320, height: 240, audiosamplerate: 44100, stereo: true }],
  ])('%s: segments start from the keyframes even when the video starts after the audio', (_, object) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata(object));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    let i = 0;
    for (let t = 0; t < 9000; t += 100) {
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      if (t === 2000) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 2000) { generator.feed(video(t, avc(t % 2000 === 0 ? 1 : 2))); }
    }

    expect(extinfs(generator)).toStrictEqual([2, 2, 2]);
  });

  test('onMetaData without the video: the AVC video that arrives later is not used, and segments are cut at the AAC frames', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 10, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata({ audiocodecid: 10 }));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    let i = 0;
    for (let t = 0; t < 7000; t += 100) {
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      if (t === 2500) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 2500) { generator.feed(video(t, avc((t - 2500) % 1000 === 0 ? 1 : 2))); }
    }

    expect(extinfs(generator)).toStrictEqual([1.003, 1.002, 1.003, 1.003, 1.002, 1.003]);
    const changes = (await segments(generator)).flatMap(pmts).filter(([version, types], index, list) => index === 0 || version !== list[index - 1][0] || types.join() !== list[index - 1][1].join());
    expect(changes).toStrictEqual([[0, [0x0F]]]);
    expect((await segments(generator)).flatMap(pids)).not.toContain(258);
  });

  test('keyframes every 0.25 s: every partial segment starts with PAT and PMT', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.25 });
    generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    let i = 0;
    for (let frame = 0; frame < 24 * 5; frame++) {
      const t = Math.round(frame * 1000 / 24);
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      generator.feed(video(t, avc(frame % 6 === 0 ? 1 : 2)));
    }

    expect(await generator.published()).toStrictEqual(true);
    expect(parts(generator).filter((part) => !/_0\.ts"/.test(part) && part.endsWith(',INDEPENDENT=YES')).length).toBeGreaterThan(0);
    const list = await partialSegments(generator);
    for (const [name, data] of list) {
      expect(pids(data).slice(0, 2), name).toStrictEqual([0, 256]);
    }
    for (const segment of await segments(generator)) {
      expect(streamTypes(segment)).toStrictEqual([0x1B, 0x0F]);
    }
  });
});

describe('Partial segments in the middle of a GOP', () => {
  test('29.97 fps, 2 s GOP: every partial segment starts with PAT and PMT, and keeps the video and audio in the order they arrived', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    let i = 0;
    for (let frame = 0; frame < 60 * 5; frame++) {
      const t = Math.round(frame * 1001 / 30);
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      generator.feed(video(t, avc(frame % 60 === 0 ? 1 : 2)));
    }

    expect(await generator.published()).toStrictEqual(true);
    expect(parts(generator).filter((part) => !part.endsWith(',INDEPENDENT=YES')).length).toBeGreaterThan(0);
    for (const [name, data] of await partialSegments(generator)) {
      expect(pids(data).slice(0, 2), name).toStrictEqual([0, 256]);
      expect(pts(data), name).toStrictEqual(pts(data).toSorted((a, b) => a - b));
    }
  });

  test('keyframes inside a partial segment also get PAT and PMT in front of them', async () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 10, partialSegmentDuration: 0.25 });
    generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    let i = 0;
    for (let frame = 0; frame < 30 * 8; frame++) {
      const t = Math.round(frame * 1000 / 30);
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      generator.feed(video(t, avc(frame % 15 === 0 ? 1 : 2)));
    }
    generator.end();

    const stream = Buffer.concat(await segments(generator));
    const list = pids(stream);
    const frames = list.flatMap((pid, index) => pid === 258 && (stream[index * 188 + 1] & 0x40) !== 0 ? [index] : []);
    const keyframes = frames.filter((_, n) => n % 15 === 0);
    expect(keyframes.length).toStrictEqual(16);
    for (const index of keyframes) {
      const before = list.slice(0, index);
      expect(before.lastIndexOf(0)).toBeGreaterThan(before.lastIndexOf(258));
    }
  });
});

describe('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier with an encoder without global header)', () => {
  test.each([
    ['with AAC', 0],
    ['with AAC starting 44 ms after the first keyframe (FFmpeg with B-frames)', 44],
  ])('%s: the video is reported as ignored, and every partial segment is cut at the AAC frames with a PMT that lists only AAC', async (_, delay) => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    expect(warnings(() => {
      generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
      generator.feed(video(0, EMPTY_AVC_SEQUENCE_HEADER));
      generator.feed(audio(0, AAC_SEQUENCE_HEADER));
      let i = 0;
      for (let t = 0; t < 4500; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        for (; delay + aac(i) < t + 100; i++) { generator.feed(audio(delay + aac(i), AAC_FRAME)); }
      }
    })).toStrictEqual(['Video sequence header is missing, video is ignored']);

    expect(await generator.published()).toStrictEqual(true);
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
    const timestamp = (t: number): number => (wrap - 2500 + t) % wrap;
    generator.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
    generator.feed(audio(timestamp(0), AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 6000; t += 100) {
      generator.feed(video(timestamp(t), avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(timestamp(t + 8), AAC_FRAME));
    }
    expect(extinfs(generator)).toStrictEqual([1, 1, 1]);
    const durations = parts(generator).map((part) => Number(/DURATION=([\d.]+)/.exec(part)![1]));
    expect(durations).toStrictEqual([0.3, 0.3, 0.3, 0.1, 0.3, 0.3, 0.3, 0.1, 0.3, 0.3, 0.3, 0.1, 0.3, 0.3, 0.3]);
  });
});

describe('Malformed messages', () => {
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
    expect(await generator.published()).toStrictEqual(true);
    expect(generator.m3u8()).toContain('#EXT-X-ENDLIST');
    expect(extinfs(generator)).toStrictEqual([1, 1, 1]);
  });
});

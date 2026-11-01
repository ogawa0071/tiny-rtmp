import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import HLSGenerator from '../src/hls-generator.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
const AAC_FRAME = Buffer.from('af0121', 'hex');
// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム)
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
// FFmpeg が配信の終了時に、映像の最後のフレームの時刻で送る AVC の end of sequence (-flvflags no_sequence_end では送らない)
const AVC_END_OF_SEQUENCE = Buffer.from('1702000000', 'hex');
// Enhanced RTMP の H.265 のフレーム (このサーバでは扱わない)
const HEVC_FRAME = Buffer.from('9168766331000000', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// 48 kHz の AAC (1 フレーム 1024 サンプル) の i 番目のフレームの timestamp (ミリ秒に丸める)
const aac = (i: number): number => Math.round(i * 1024 * 1000 / 48000);

const targetduration = (m3u8: string): number => Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(m3u8)![1]);
const extinfs = (m3u8: string): number[] => [... m3u8.matchAll(/#EXTINF:([\d.]+),/g)].map(([, duration]) => Number(duration));

// プレイリストに載っているセグメントと、TS パケットの PID の一覧
const segments = (generator: HLSGenerator): Buffer[] => {
  return [... generator.m3u8().matchAll(/^(\d+)\.ts$/gm)].map(([, msn]) => generator.segment(Number(msn))!);
};
const pids = (segment: Buffer): number[] => {
  return Array.from({ length: segment.byteLength / 188 }, (_, i) => segment.readUInt16BE(i * 188 + 1) & 0x1FFF);
};

describe('End of stream', () => {
  // FFmpeg が 30 fps (1 秒ごとにキーフレーム、B フレーム 2 枚) と AAC の 5 秒のファイルを -c copy で送る時と同じ timestamp
  // 映像の timestamp は DTS で表示時刻より 67 ミリ秒早く、FFmpeg は DTS が負にならないように全体を 67 ミリ秒遅らせるので、
  // 映像と同時に終わる音声でも、最後の音声の timestamp (5060) は映像の最後のフレーム (4967) どころか次のキーフレームの時刻 (5000) より後になる
  test.each([
    ['with the AVC end of sequence (FFmpeg)', true],
    ['without the AVC end of sequence (FFmpeg -flvflags no_sequence_end)', false],
  ])('%s: the last segment ends at the last video frame and EXT-X-TARGETDURATION does not change', (_, eos) => {
    const generator = new HLSGenerator();
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    const audios = Array.from({ length: 216 }, (_, i) => Math.round(i * 1024 / 44.1) + 67); // 1024 サンプルずつの AAC (最後は 4993 + 67 ミリ秒)
    for (let i = 0; i < 150; i++) {
      const timestamp = Math.round(i * 1000 / 30);
      while (audios.length > 0 && audios[0] < timestamp) { generator.feed(audio(audios.shift()!, AAC_FRAME)); }
      generator.feed(video(timestamp, avc(i % 30 === 0 ? 1 : 2)));
    }
    for (const timestamp of audios) { generator.feed(audio(timestamp, AAC_FRAME)); }
    const live = generator.m3u8();
    if (eos) { generator.feed(video(4967, AVC_END_OF_SEQUENCE)); }
    generator.end();

    const final = generator.m3u8();
    expect(targetduration(final)).toStrictEqual(targetduration(live));
    expect(extinfs(final)).toStrictEqual([1, 1, 1, 0.967]);
  });
});

describe('Streams without video', () => {
  test.each([
    ['audio only (FFmpeg -vn)', { audiocodecid: 10, audiosamplerate: 48000, stereo: true }, null],
    ['H.265 + AAC (videocodecid is the FourCC number)', { videocodecid: 0x68766331, audiocodecid: 10 }, HEVC_FRAME],
  ])('%s: segments are cut at the AAC frames every second or more, and the playlist is published', async (_, object, frame) => {
    const generator = new HLSGenerator();
    generator.feed(onmetadata(object));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let i = 0; aac(i) < 4500; i++) {
      generator.feed(audio(aac(i), AAC_FRAME));
      if (frame != null && i % 3 === 0) { generator.feed(video(aac(i), frame)); }
    }

    expect(await generator.published()).toStrictEqual(true);
    // 1 秒以上たってから最初の AAC のフレームで区切る (フレームは 1024 / 48000 秒ごとなので、1 秒より少し長くなる)
    expect(extinfs(generator.m3u8())).toStrictEqual([1.003, 1.002, 1.003, 1.003]);
    for (const segment of segments(generator)) {
      // セグメントは PAT/PMT から始まり、PAT/PMT はいつも通り 100 ミリ秒ごとに入れる (AAC のフレームごとには入れない)
      expect(pids(segment).slice(0, 2)).toStrictEqual([0, 256]);
      expect(pids(segment).filter((pid) => pid === 0).length).toBeLessThanOrEqual(11);
    }
  });
});

describe('Streams with video', () => {
  test.each([
    ['onMetaData with AVC', { videocodecid: 7, audiocodecid: 10 }],
    // yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる
    ['onMetaData without codec ids (yasea)', { width: 320, height: 240, audiosamplerate: 44100, stereo: true }],
    ['no onMetaData', null],
  ])('%s: segments start from the keyframes even when the video starts after the audio', (_, object) => {
    const generator = new HLSGenerator();
    if (object != null) { generator.feed(onmetadata(object)); }
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 映像 (10 fps、2 秒ごとにキーフレーム) は音声より 2 秒遅れて届く
    let i = 0;
    for (let t = 0; t < 9000; t += 100) {
      for (; aac(i) <= t; i++) { generator.feed(audio(aac(i), AAC_FRAME)); }
      if (t === 2000) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 2000) { generator.feed(video(t, avc(t % 2000 === 0 ? 1 : 2))); }
    }
    generator.end();

    // 音声だけのセグメントは作らない (最初のセグメントは 2 秒のキーフレームから)
    expect(extinfs(generator.m3u8())).toStrictEqual([2, 2, 2, 0.9]);
  });
});

describe('RTMP timestamps that wrap around', () => {
  test.each([
    ['the RTMP specification (32bit)', 2 ** 32],
    ['FFmpeg (31bit)', 2 ** 31],
  ])('segments keep being made after the timestamps of %s wrap around', (_, wrap) => {
    const generator = new HLSGenerator();
    // 配信を始めてから 2.5 秒後に timestamp が一周して 0 に戻る
    const timestamp = (t: number): number => (wrap - 2500 + t) % wrap;
    generator.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
    generator.feed(audio(timestamp(0), AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 6000; t += 100) {
      generator.feed(video(timestamp(t), avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(timestamp(t + 8), AAC_FRAME));
    }
    generator.end();
    // 一周した後も 0, 1000, ..., 5000 ms のキーフレームからセグメントができる (最後は最後の映像のフレームの 5900 ms まで、プレイリストには最後の 4 つが載る)
    expect(extinfs(generator.m3u8())).toStrictEqual([1, 1, 1, 0.9]);
  });
});

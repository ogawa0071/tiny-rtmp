import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import LLHLSGenerator from '../src/llhls-generator.mts';

// FFmpeg が送ってくる AVC と AAC の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
const AAC_FRAME = Buffer.from('af0121', 'hex');
// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム)
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);

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
  });
});

describe('Streams with video', () => {
  // yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる
  test('onMetaData without codec ids (yasea): segments start from the keyframes even when the video starts after the audio', () => {
    const generator = new LLHLSGenerator({ liveWindowLength: 3, partialSegmentDuration: 0.3 });
    generator.feed(onmetadata({ width: 320, height: 240, audiosamplerate: 44100, stereo: true }));
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
});

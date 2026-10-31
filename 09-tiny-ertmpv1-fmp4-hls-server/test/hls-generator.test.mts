import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import HLSGenerator from '../src/hls-generator.mts';

// FFmpeg が送ってくる AVC と AAC の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const metadata = (videocodecid: AMF0Value, audiocodecid: AMF0Value): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', { videocodecid, audiocodecid }],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、MP3 (SoundFormat 2) と AAC のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const MP3_FRAME = Buffer.from('2fff', 'hex');
const AAC_FRAME = Buffer.from('af0121', 'hex');

// プレイリストに載っているセグメントの長さ (秒)
const extinfs = (generator: HLSGenerator): number[] => {
  return [... generator.m3u8().matchAll(/#EXTINF:([0-9.]+),/g)].map((match) => Number.parseFloat(match[1]));
};

// プレイリストに載っているセグメントに入っている、トラックの番号 (tfhd の track_ID)
const trackIds = (generator: HLSGenerator): Set<number> => {
  const ids = new Set<number>();
  for (const [, msn] of generator.m3u8().matchAll(/^(\d+)\.m4s$/gm)) {
    const segment = generator.segment(Number(msn))!;
    // tfhd: size (4byte), 'tfhd' (4byte), version と flags (4byte), track_ID (4byte)
    for (let index = segment.indexOf('tfhd'); index >= 0; index = segment.indexOf('tfhd', index + 1)) {
      ids.add(segment.readUInt32BE(index + 8));
    }
  }
  return ids;
};

describe('Tracks that cannot be put into fMP4', () => {
  test('H.264 + MP3: segments start from the first keyframe even when it arrives before the first MP3 frame', () => {
    const generator = new HLSGenerator();
    generator.feed(metadata(7, 2));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    // FFmpeg の -c:v libx264 (と既定の MP3) と同じく、0 ms のキーフレームが最初の MP3 (8 ms) より先に届く
    for (let t = 0; t < 3000; t += 100) {
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(t + 8, MP3_FRAME));
    }
    generator.end();
    // 0, 1000, 2000 ms のキーフレームから始まる 3 つのセグメントができる (最後は最後のフレームの先頭 2900 ms まで)
    expect(extinfs(generator)).toStrictEqual([1, 1, 0.9]);
  });

  test('Sorenson H.263 + AAC: segments start from the AAC frames that arrive before the first video frame', () => {
    const generator = new HLSGenerator();
    generator.feed(metadata(2, 10));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 音声だけの配信として 1 秒ごとにセグメントを区切るので、0 ms からの AAC が全て使われれば 3 つのセグメントができる
    for (let t = 0; t <= 3000; t += 100) {
      generator.feed(audio(t, AAC_FRAME));
      if (t === 500) { generator.feed(video(t, Buffer.from('2200000000', 'hex'))); } // Sorenson H.263 (CodecID 2) のフレーム
    }
    generator.end();
    expect(extinfs(generator)).toStrictEqual([1, 1, 1]);
  });

  test('H.265 + AAC: when videocodecid is the FourCC number, the video sequence header is waited for', () => {
    const generator = new HLSGenerator();
    generator.feed(metadata(0x68766331, 10));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 映像の初期化情報が届く前の AAC は捨てる (映像のない初期化セグメントを作らない)
    generator.feed(audio(0, AAC_FRAME));
    expect(generator.initialize()).toBeNull();
  });

  test('a track whose sequence header arrives after the initialization segment is made is not written', () => {
    const generator = new HLSGenerator();
    // onMetaData には Sorenson H.263 と書かれているが、後から AVC が届く
    generator.feed(metadata(2, 10));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let t = 0; t <= 3000; t += 100) {
      generator.feed(audio(t, AAC_FRAME));
      if (t === 500) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 500) { generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2))); }
    }
    generator.end();
    // 初期化セグメントは音声だけで作ったので、セグメントにも音声 (track_ID 2) だけを入れる
    expect(extinfs(generator)).toStrictEqual([1, 1, 1]);
    expect(trackIds(generator)).toStrictEqual(new Set([2]));
  });
});

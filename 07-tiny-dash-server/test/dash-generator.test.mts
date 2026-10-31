import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import DASHGenerator from '../src/dash-generator.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const metadata = (videocodecid: AMF0Value, audiocodecid: AMF0Value): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', { videocodecid, audiocodecid }],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、AAC と MP3 (SoundFormat 2) のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');
const MP3_FRAME = Buffer.from('2fff', 'hex');

describe('MPD', () => {
  test('an AAC sequence header that arrives late is waited for, so the MPD never disappears or gains a track', () => {
    const generator = new DASHGenerator();
    generator.feed(metadata(7, 10));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    // 10 fps の映像 (1 秒ごとにキーフレーム) と、3 秒遅れて初期化情報が届く AAC (1024 サンプルごと) を timestamp 順に入れる
    const messages = [
      ... Array.from({ length: 60 }, (_, i) => video(i * 100, avc(i % 10 === 0 ? 1 : 2))),
      audio(3000, AAC_SEQUENCE_HEADER),
      ... Array.from({ length: 129 }, (_, i) => audio(3000 + Math.round(i * 1024 * 1000 / 44100), AAC_FRAME)),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const mpds = messages.map((message) => {
      generator.feed(message);
      return generator.mpd();
    });

    const first = mpds.findIndex((mpd) => mpd != null);
    expect(first).toBeGreaterThan(0);
    // 一度 MPD を返したら返し続けて、最初の MPD から映像と音声の両方が載っている
    for (const mpd of mpds.slice(first)) {
      expect(mpd).toContain('contentType="video"');
      expect(mpd).toContain('contentType="audio"');
    }
  });

  test('an audio codec that cannot be put into fMP4 (MP3) is not waited for', () => {
    const generator = new DASHGenerator();
    generator.feed(metadata(7, 2));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    for (let t = 0; t < 3000; t += 100) {
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(t + 8, MP3_FRAME));
    }

    const mpd = generator.mpd();
    expect(mpd).toContain('contentType="video"');
    expect(mpd).not.toContain('contentType="audio"');
  });
});

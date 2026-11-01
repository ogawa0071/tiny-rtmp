import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object, AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import DASHGenerator from '../src/dash-generator.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const onmetadata = (object: AMF0Object, timestamp: number = 0): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp, data: ['@setDataFrame', 'onMetaData', object],
});
const metadata = (videocodecid: AMF0Value, audiocodecid: AMF0Value): Message => onmetadata({ videocodecid, audiocodecid });
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、AAC と MP3 (SoundFormat 2) のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');
const MP3_FRAME = Buffer.from('2fff', 'hex');

// FFmpeg 8.0 や OBS が AAC の初期化情報の後に送ってくる Enhanced RTMP の音声 (ExAudioTagHeader: SoundFormat 9)
// FFmpeg 8.0 の 5.1ch の AAC の初期化情報と、その後に送られる MultichannelConfig ('mp4a', AudioChannelOrder.Native, 6ch, FL|FR|FC|LFE|SL|SR)
const AAC_51_SEQUENCE_HEADER = Buffer.from('af00123056e500', 'hex');
const MULTICHANNEL_CONFIG = Buffer.from('946d70346101060000060f', 'hex');
// 2 つ目の音声トラック (Multitrack, OneTrack, trackId 1) の AAC の初期化情報とフレーム
const SECOND_TRACK_SEQUENCE_HEADER = Buffer.from('95006d70346101120856e500', 'hex');
const SECOND_TRACK_FRAME = Buffer.from('95016d7034610121', 'hex');

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

  // onMetaData に MP3 (SoundFormat 2) と書かれている配信と、AAC と書かれているのに MP3 が届く配信
  test.each([
    ['onMetaData says MP3', 2],
    ['onMetaData says AAC but MP3 arrives', 10],
  ])('an audio codec that this server does not put into fMP4 (MP3) is not waited for (%s)', (_, audiocodecid) => {
    const generator = new DASHGenerator();
    generator.feed(metadata(7, audiocodecid));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    for (let t = 0; t < 3000; t += 100) {
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(t + 8, MP3_FRAME));
    }

    const mpd = generator.mpd();
    expect(mpd).toContain('contentType="video"');
    expect(mpd).not.toContain('contentType="audio"');
  });

  test('Enhanced RTMP audio sent after the AAC sequence header (MultichannelConfig, a second audio track) does not stop the AAC track', () => {
    const cases = [
      { headers: [AAC_51_SEQUENCE_HEADER, MULTICHANNEL_CONFIG], frames: [AAC_FRAME] },
      { headers: [AAC_SEQUENCE_HEADER, SECOND_TRACK_SEQUENCE_HEADER], frames: [AAC_FRAME, SECOND_TRACK_FRAME] },
    ];
    for (const { headers, frames } of cases) {
      const generator = new DASHGenerator();
      generator.feed(metadata(7, 10));
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (const data of headers) { generator.feed(audio(0, data)); }
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        for (const data of frames) { generator.feed(audio(t + 8, data)); }
      }

      const mpd = generator.mpd();
      expect(mpd).toContain('contentType="video"');
      expect(mpd).toContain('contentType="audio"');
    }
  });

  test('an onMetaData sent again during the publish does not add or drop a track, whether or not the MPD was requested before it', () => {
    // 最初の onMetaData、配信の途中で送り直される onMetaData、MPD に載るトラック
    // (送り直されるのは、コーデックの書かれていない曲名の更新、音声の書かれていないもの、最初になかった音声を足すもの)
    const cases: [AMF0Object, AMF0Object, string[]][] = [
      [{ videocodecid: 7, audiocodecid: 10 }, { title: 'next' }, ['video', 'audio']],
      [{ videocodecid: 7, audiocodecid: 10 }, { videocodecid: 7 }, ['video', 'audio']],
      [{ videocodecid: 7 }, { videocodecid: 7, audiocodecid: 10 }, ['video']],
    ];
    for (const [first, again, tracks] of cases) {
      // 配信の最初から MPD を取りに来る視聴者がいる時と、onMetaData が送り直された後に最初の視聴者が来た時
      for (const firstRequest of [0, 4000]) {
        const generator = new DASHGenerator();
        generator.feed(onmetadata(first));
        generator.feed(video(0, AVC_SEQUENCE_HEADER));
        generator.feed(audio(0, AAC_SEQUENCE_HEADER));
        const mpds: (string | null)[] = [];
        for (let t = 0; t < 6000; t += 100) {
          if (t === 3000) { generator.feed(onmetadata(again, t)); }
          generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
          generator.feed(audio(t + 8, AAC_FRAME));
          if (t >= firstRequest) { mpds.push(generator.mpd()); }
        }

        // 一度 MPD を返したら返し続けて、載っているトラックは変わらない
        const served = mpds.findIndex((mpd) => mpd != null);
        expect(served).not.toBe(-1);
        for (const mpd of mpds.slice(served)) {
          expect([... (mpd ?? '').matchAll(/contentType="([a-z]+)"/g)].map(([, type]) => type)).toStrictEqual(tracks);
        }
      }
    }
  });
});

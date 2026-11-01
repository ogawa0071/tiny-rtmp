import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import { EncryptionFormat, EncryptionScheme } from '../../08-tiny-dash-cenc-server/src/cenc.mts';
import DASHGenerator from '../src/dash-generator.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、AAC のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');
// MP3 (SoundFormat 2) のフレーム
const MP3_FRAME = Buffer.from('2fff', 'hex');

// 6 秒間、10 fps の映像 (1 秒ごとにキーフレーム) と、audioStart から AAC (初期化情報と 100 ミリ秒ごとのフレーム) を送る
// 映像を送るたびに、firstRequest 以降は MPD を取りに行く (届いた MPD を返す)
const publish = (generator: DASHGenerator, { audioStart, firstRequest }: { audioStart: number | null; firstRequest: number; }): (string | null)[] => {
  const mpds: (string | null)[] = [];
  for (let t = 0; t < 6000; t += 100) {
    if (t === audioStart) { generator.feed(audio(t, AAC_SEQUENCE_HEADER)); }
    generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
    if (audioStart != null && t >= audioStart) { generator.feed(audio(t + 8, AAC_FRAME)); }
    if (t >= firstRequest) { mpds.push(generator.mpd()); }
  }
  return mpds;
};

// 一度 MPD を返したら返し続けて、載っているトラックは変わらない
const expectTracks = (mpds: (string | null)[], tracks: string[]): void => {
  const served = mpds.findIndex((mpd) => mpd != null);
  expect(served).not.toBe(-1);
  for (const mpd of mpds.slice(served)) {
    expect([... (mpd ?? '').matchAll(/contentType="([a-z]+)"/g)].map(([, type]) => type)).toStrictEqual(tracks);
  }
};

describe('MPD', () => {
  // yasea は、videocodecid も audiocodecid もない onMetaData を NetStream.Publish.Start の後に 1 回だけ送ってくる
  const YASEA_ONMETADATA = { duration: 0, width: 320, height: 240, videodatarate: 0, framerate: 0, audiodatarate: 0, audiosamplerate: 44100, audiosamplesize: 16, stereo: true, filesize: 0 };
  test.each([
    ['onMetaData without codec ids (yasea)', YASEA_ONMETADATA],
    ['no onMetaData (FFmpeg -flvflags no_metadata)', null],
    ['onMetaData that declares only the video', { videocodecid: 7 }],
  ])('%s: the tracks whose sequence headers arrive by the time the MPD can be made are used', (_, object) => {
    // AAC の初期化情報が届く時刻 (null なら音声なし)、MPD に載るトラック
    // (最初の映像のセグメントができて MPD を作れるようになる 1 秒より後に届いた音声は、MPD に足さない)
    const cases: [number | null, string[]][] = [
      [0, ['video', 'audio']],
      [300, ['video', 'audio']],
      [null, ['video']],
      [3000, ['video']],
    ];
    for (const scheme of [EncryptionScheme.CENC, EncryptionScheme.CBCS]) {
      for (const [audioStart, tracks] of cases) {
        for (const firstRequest of [0, 4000]) {
          const generator = new DASHGenerator(EncryptionFormat.from(scheme), Buffer.alloc(16, 1), Buffer.alloc(16, 2));
          if (object != null) { generator.feed(onmetadata(object)); }
          generator.feed(video(0, AVC_SEQUENCE_HEADER));
          expectTracks(publish(generator, { audioStart, firstRequest }), tracks);
        }
      }
    }
  });

  // FFmpeg は ADTS の AAC (MPEG-TS や HLS などの入力) を -c copy で送る時、中身が空の AAC の初期化情報 (af00) を先に送り、本当の初期化情報は最初の音声のフレームの直前に送ってくる
  // (FFmpeg 8.0 以降の 5.1ch などでは、中身が空の初期化情報の後に Enhanced RTMP の形式 (SoundFormat 9) の MultichannelConfig も送ってくる)
  // 音声が映像より遅れて始まり、MPD を作れるようになる (最初の映像のセグメントができる) 1 秒より後に本当の初期化情報が届いても、AAC が届くと分かっているので待つ
  test.each([
    ['stereo, no onMetaData', null, ['af00']],
    ['5.1ch (MultichannelConfig)', { videocodecid: 7, audiocodecid: 10 }, ['af00', '946d70346101060000003f']],
  ])('FFmpeg -c copy from ADTS AAC, %s: the AAC track is waited for even if the audio starts late', (_, object, headers) => {
    for (const scheme of [EncryptionScheme.CENC, EncryptionScheme.CBCS]) {
      for (const firstRequest of [0, 4000]) {
        const generator = new DASHGenerator(EncryptionFormat.from(scheme), Buffer.alloc(16, 1), Buffer.alloc(16, 2));
        if (object != null) { generator.feed(onmetadata(object)); }
        generator.feed(video(0, AVC_SEQUENCE_HEADER));
        for (const hex of headers) { generator.feed(audio(0, Buffer.from(hex, 'hex'))); }
        expectTracks(publish(generator, { audioStart: 2500, firstRequest }), ['video', 'audio']);
      }
    }
  });

  // onMetaData に MP3 (SoundFormat 2) と書かれている配信と、AAC と書かれているのに MP3 が届く配信
  test.each([
    ['onMetaData says MP3', 2],
    ['onMetaData says AAC but MP3 arrives', 10],
  ])('an audio codec that this server does not put into fMP4 (MP3) is not waited for (%s)', (_, audiocodecid) => {
    for (const scheme of [EncryptionScheme.CENC, EncryptionScheme.CBCS]) {
      const generator = new DASHGenerator(EncryptionFormat.from(scheme), Buffer.alloc(16, 1), Buffer.alloc(16, 2));
      generator.feed(onmetadata({ videocodecid: 7, audiocodecid }));
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        generator.feed(audio(t + 8, MP3_FRAME));
      }

      const mpd = generator.mpd();
      expect(mpd).toContain('contentType="video"');
      expect(mpd).not.toContain('contentType="audio"');
    }
  });

  test('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier): the video is reported as ignored and the AAC track is put into the MPD', () => {
    // FFmpeg 6.0 以前は、エンコーダが初期化情報を出さない時、中身が空の AVC の初期化情報しか送らず、フレームも開始コード付き (Annex B) のまま送ってくる
    for (const scheme of [EncryptionScheme.CENC, EncryptionScheme.CBCS]) {
      const warnings: string[] = [];
      registerLogger(Object.assign(new NoopLogger(), { warn: (message: string) => { warnings.push(message); } }));
      let mpds: (string | null)[] = [];
      try {
        const generator = new DASHGenerator(EncryptionFormat.from(scheme), Buffer.alloc(16, 1), Buffer.alloc(16, 2));
        generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
        generator.feed(video(0, Buffer.from('1700000000', 'hex')));
        mpds = publish(generator, { audioStart: 0, firstRequest: 0 });
      } finally {
        registerLogger(new NoopLogger());
      }

      // 映像は使えないと警告して、音声だけを MPD に載せる (映像の初期化情報を待ち続けて、MPD を作れないことはない)
      expect(warnings).toStrictEqual(['Video sequence header is missing, video is ignored']);
      expectTracks(mpds, ['audio']);
    }
  });
});

describe('RTMP timestamps that wrap around', () => {
  test.each([
    ['the RTMP specification (32bit)', 2 ** 32],
    ['FFmpeg (31bit)', 2 ** 31],
  ])('segments keep being made after the timestamps of %s wrap around', (_, wrap) => {
    // 配信を始めてから 2.5 秒後に timestamp が一周して 0 に戻る
    const timestamp = (t: number): number => (wrap - 2500 + t) % wrap;
    for (const scheme of [EncryptionScheme.CENC, EncryptionScheme.CBCS]) {
      const generator = new DASHGenerator(EncryptionFormat.from(scheme), Buffer.alloc(16, 1), Buffer.alloc(16, 2));
      generator.feed(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
      generator.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
      generator.feed(audio(timestamp(0), AAC_SEQUENCE_HEADER));
      for (let t = 0; t < 6000; t += 100) {
        generator.feed(video(timestamp(t), avc(t % 1000 === 0 ? 1 : 2)));
        generator.feed(audio(timestamp(t + 8), AAC_FRAME));
      }
      // 一周した後も映像は 1 秒ごとに区切られ、セグメントの開始時刻 (S@t) も戻らない (ライブウィンドウには最後の 3 つが載る)
      const [videoTimeline] = generator.mpd()!.split('contentType="audio"');
      const segments = [... videoTimeline.matchAll(/<S t="(\d+)" d="(\d+)"/g)].map(([, t, d]) => [Number(t), Number(d)]);
      expect(segments).toStrictEqual([[wrap - 500, 1000], [wrap + 500, 1000], [wrap + 1500, 1000]]);
    }
  });
});

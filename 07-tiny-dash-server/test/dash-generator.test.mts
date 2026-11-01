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

// 6 秒間、10 fps の映像 (1 秒ごとにキーフレーム) と、audioStart から AAC (初期化情報と 100 ミリ秒ごとのフレーム) を送る
// 映像を送るたびに、firstRequest 以降は MPD を取りに行く (届いた MPD を返す)
const publish = (generator: DASHGenerator, { audioStart, firstRequest, beforeVideo }: { audioStart: number | null; firstRequest: number; beforeVideo?: (t: number) => void; }): (string | null)[] => {
  const mpds: (string | null)[] = [];
  for (let t = 0; t < 6000; t += 100) {
    beforeVideo?.(t);
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
    // 最初の onMetaData、配信の途中で送り直される onMetaData、AAC が届き始める時刻、MPD に載るトラック
    // (送り直されるのは、コーデックの書かれていない曲名の更新、音声の書かれていないもの、後から始めた音声を足すもの)
    const cases: [AMF0Object, AMF0Object, number, string[]][] = [
      [{ videocodecid: 7, audiocodecid: 10 }, { title: 'next' }, 0, ['video', 'audio']],
      [{ videocodecid: 7, audiocodecid: 10 }, { videocodecid: 7 }, 0, ['video', 'audio']],
      [{ videocodecid: 7 }, { videocodecid: 7, audiocodecid: 10 }, 3000, ['video']],
    ];
    for (const [first, again, audioStart, tracks] of cases) {
      // 配信の最初から MPD を取りに来る視聴者がいる時と、onMetaData が送り直された後に最初の視聴者が来た時
      for (const firstRequest of [0, 4000]) {
        const generator = new DASHGenerator();
        generator.feed(onmetadata(first));
        generator.feed(video(0, AVC_SEQUENCE_HEADER));
        const mpds = publish(generator, { audioStart, firstRequest, beforeVideo: (t) => {
          if (t === 3000) { generator.feed(onmetadata(again, t)); }
        } });
        expectTracks(mpds, tracks);
      }
    }
  });

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
    for (const [audioStart, tracks] of cases) {
      for (const firstRequest of [0, 4000]) {
        const generator = new DASHGenerator();
        if (object != null) { generator.feed(onmetadata(object)); }
        generator.feed(video(0, AVC_SEQUENCE_HEADER));
        expectTracks(publish(generator, { audioStart, firstRequest }), tracks);
      }
    }
  });

  test.each([
    // onMetaData に AVC と書かれていなければ、音声だけで MPD を作れるようになった後に届いた映像は、MPD に足さない
    ['no onMetaData', null, ['audio']],
    // onMetaData に AVC と書かれていれば、映像の初期化情報が遅れて届いても待つ
    ['onMetaData that declares the video', { videocodecid: 7, audiocodecid: 10 }, ['video', 'audio']],
  ])('%s: an AVC sequence header that arrives after the first audio segment', (_, object, tracks) => {
    for (const firstRequest of [0, 4000]) {
      const generator = new DASHGenerator();
      if (object != null) { generator.feed(onmetadata(object)); }
      generator.feed(audio(0, AAC_SEQUENCE_HEADER));
      const mpds: (string | null)[] = [];
      for (let t = 0; t < 6000; t += 100) {
        // 最初の音声のセグメント (1 秒) ができた後に、映像が届き始める
        if (t === 3000) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
        if (t >= 3000) { generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2))); }
        generator.feed(audio(t + 8, AAC_FRAME));
        if (t >= firstRequest) { mpds.push(generator.mpd()); }
      }
      expectTracks(mpds, tracks);
    }
  });
});

describe('Sequence headers without the configuration', () => {
  // FFmpeg は、配信を始める時にまだ初期化情報がないと、中身が空の初期化情報を先に送り、最初のフレームの直前に本当の初期化情報を送り直す
  test.each([
    // ADTS の AAC (MPEG-TS などの入力) を -c copy で送る時は、AAC の初期化情報が空 (AudioSpecificConfig がない)
    ['AAC (FFmpeg -c copy from ADTS AAC)', AVC_SEQUENCE_HEADER, Buffer.from('af00', 'hex')],
    // エンコーダが初期化情報を出さない時 (-flags -global_header など) は、AVC の初期化情報が空 (AVCDecoderConfigurationRecord がない)
    ['AVC (FFmpeg with an encoder that does not output a global header)', Buffer.from('1700000000', 'hex'), AAC_SEQUENCE_HEADER],
  ])('%s: the empty sequence header is ignored until the real one arrives', (_, videoHeader, audioHeader) => {
    const generator = new DASHGenerator();
    generator.feed(metadata(7, 10));
    generator.feed(video(0, videoHeader));
    generator.feed(audio(0, audioHeader));
    for (let t = 0; t < 3000; t += 100) {
      // 本当の初期化情報は、最初のフレームの直前に届く
      if (t === 0) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      if (t === 0) { generator.feed(audio(t + 45, AAC_SEQUENCE_HEADER)); }
      generator.feed(audio(t + 45, AAC_FRAME));
    }

    const mpd = generator.mpd();
    expect(mpd).toContain('codecs="avc1.4D400D"');
    expect(mpd).toContain('codecs="mp4a.40.2"');
  });

  // FFmpeg は ADTS の AAC (MPEG-TS や HLS などの入力) を -c copy で送る時、中身が空の AAC の初期化情報 (af00) を先に送り、本当の初期化情報は最初の音声のフレームの直前に送ってくる
  // (FFmpeg 8.0 以降の 5.1ch などでは、中身が空の初期化情報の後に Enhanced RTMP の形式 (SoundFormat 9) の MultichannelConfig も送ってくる)
  // 音声が映像より遅れて始まり、MPD を作れるようになる (最初の映像のセグメントができる) 1 秒より後に本当の初期化情報が届いても、AAC が届くと分かっているので待つ
  test.each<[string, AMF0Object | null, string[]]>([
    ['stereo, no onMetaData', null, ['af00']],
    ['5.1ch (MultichannelConfig)', { videocodecid: 7, audiocodecid: 10 }, ['af00', '946d70346101060000003f']],
    ['5.1ch (MultichannelConfig), no onMetaData', null, ['af00', '946d70346101060000003f']],
  ])('FFmpeg -c copy from ADTS AAC, %s: the AAC track is waited for even if the audio starts late', (_, object, headers) => {
    for (const firstRequest of [0, 4000]) {
      const generator = new DASHGenerator();
      if (object != null) { generator.feed(onmetadata(object)); }
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (const hex of headers) { generator.feed(audio(0, Buffer.from(hex, 'hex'))); }
      expectTracks(publish(generator, { audioStart: 2500, firstRequest }), ['video', 'audio']);
    }
  });
});

describe('RTMP timestamps that wrap around', () => {
  test.each([
    ['the RTMP specification (32bit)', 2 ** 32],
    ['FFmpeg (31bit)', 2 ** 31],
  ])('segments keep being made after the timestamps of %s wrap around', (_, wrap) => {
    const generator = new DASHGenerator();
    // 配信を始めてから 2.5 秒後に timestamp が一周して 0 に戻る
    const timestamp = (t: number): number => (wrap - 2500 + t) % wrap;
    generator.feed(metadata(7, 10));
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
  });
});

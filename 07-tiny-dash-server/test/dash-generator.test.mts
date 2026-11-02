import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object, AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import DASHGenerator from '../src/dash-generator.mts';

const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const onmetadata = (object: AMF0Object, timestamp: number = 0): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp, data: ['@setDataFrame', 'onMetaData', object],
});
const metadata = (videocodecid: AMF0Value, audiocodecid: AMF0Value): Message => onmetadata({ videocodecid, audiocodecid });
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');
const MP3_FRAME = Buffer.from('2fff', 'hex');

const AAC_51_SEQUENCE_HEADER = Buffer.from('af00123056e500', 'hex');
const MULTICHANNEL_CONFIG = Buffer.from('946d70346101060000060f', 'hex');
const SECOND_TRACK_SEQUENCE_HEADER = Buffer.from('95006d70346101120856e500', 'hex');
const SECOND_TRACK_FRAME = Buffer.from('95016d7034610121', 'hex');

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
    for (const mpd of mpds.slice(first)) {
      expect(mpd).toContain('contentType="video"');
      expect(mpd).toContain('contentType="audio"');
    }
  });

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
    const cases: [AMF0Object, AMF0Object, number, string[]][] = [
      [{ videocodecid: 7, audiocodecid: 10 }, { title: 'next' }, 0, ['video', 'audio']],
      [{ videocodecid: 7, audiocodecid: 10 }, { videocodecid: 7 }, 0, ['video', 'audio']],
      [{ videocodecid: 7 }, { videocodecid: 7, audiocodecid: 10 }, 3000, ['video']],
    ];
    for (const [first, again, audioStart, tracks] of cases) {
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

  const YASEA_ONMETADATA = { duration: 0, width: 320, height: 240, videodatarate: 0, framerate: 0, audiodatarate: 0, audiosamplerate: 44100, audiosamplesize: 16, stereo: true, filesize: 0 };
  test.each([
    ['onMetaData without codec ids (yasea)', YASEA_ONMETADATA],
    ['no onMetaData (FFmpeg -flvflags no_metadata)', null],
    ['onMetaData that declares only the video', { videocodecid: 7 }],
  ])('%s: the tracks whose sequence headers arrive by the time the MPD can be made are used', (_, object) => {
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
    ['no onMetaData', null, ['audio']],
    ['onMetaData that declares the video', { videocodecid: 7, audiocodecid: 10 }, ['video', 'audio']],
  ])('%s: an AVC sequence header that arrives after the first audio segment', (_, object, tracks) => {
    for (const firstRequest of [0, 4000]) {
      const generator = new DASHGenerator();
      if (object != null) { generator.feed(onmetadata(object)); }
      generator.feed(audio(0, AAC_SEQUENCE_HEADER));
      const mpds: (string | null)[] = [];
      for (let t = 0; t < 6000; t += 100) {
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
  test.each([
    ['AAC (FFmpeg -c copy from ADTS AAC)', AVC_SEQUENCE_HEADER, Buffer.from('af00', 'hex')],
    ['AVC (FFmpeg with an encoder that does not output a global header)', Buffer.from('1700000000', 'hex'), AAC_SEQUENCE_HEADER],
  ])('%s: the empty sequence header is ignored until the real one arrives', (_, videoHeader, audioHeader) => {
    const generator = new DASHGenerator();
    generator.feed(metadata(7, 10));
    generator.feed(video(0, videoHeader));
    generator.feed(audio(0, audioHeader));
    for (let t = 0; t < 3000; t += 100) {
      if (t === 0) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      if (t === 0) { generator.feed(audio(t + 45, AAC_SEQUENCE_HEADER)); }
      generator.feed(audio(t + 45, AAC_FRAME));
    }

    const mpd = generator.mpd();
    expect(mpd).toContain('codecs="avc1.4D400D"');
    expect(mpd).toContain('codecs="mp4a.40.2"');
  });

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

  test('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier): the video is reported as ignored and the AAC track is put into the MPD', () => {
    const warnings: string[] = [];
    registerLogger(Object.assign(new NoopLogger(), { warn: (message: string) => { warnings.push(message); } }));
    let mpds: (string | null)[] = [];
    try {
      const generator = new DASHGenerator();
      generator.feed(metadata(7, 10));
      generator.feed(video(0, Buffer.from('1700000000', 'hex')));
      mpds = publish(generator, { audioStart: 0, firstRequest: 0 });
    } finally {
      registerLogger(new NoopLogger());
    }

    expect(warnings).toStrictEqual(['Video sequence header is missing, video is ignored']);
    expectTracks(mpds, ['audio']);
  });

  test('H.264 whose sequence header arrives after the first frames: the video stays ignored, so the MPD does not gain the video track', () => {
    const warnings: string[] = [];
    registerLogger(Object.assign(new NoopLogger(), { warn: (message: string) => { warnings.push(message); } }));
    let mpds: (string | null)[] = [];
    try {
      const generator = new DASHGenerator();
      generator.feed(metadata(7, 10));
      mpds = publish(generator, { audioStart: 0, firstRequest: 0, beforeVideo: (t) => {
        if (t === 300) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
      } });
    } finally {
      registerLogger(new NoopLogger());
    }

    expect(warnings).toStrictEqual(['Video sequence header is missing, video is ignored']);
    expectTracks(mpds, ['audio']);
  });
});

describe('RTMP timestamps that wrap around', () => {
  test.each([
    ['the RTMP specification (32bit)', 2 ** 32],
    ['FFmpeg (31bit)', 2 ** 31],
  ])('segments keep being made after the timestamps of %s wrap around', (_, wrap) => {
    const generator = new DASHGenerator();
    const timestamp = (t: number): number => (wrap - 2500 + t) % wrap;
    generator.feed(metadata(7, 10));
    generator.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
    generator.feed(audio(timestamp(0), AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 6000; t += 100) {
      generator.feed(video(timestamp(t), avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(timestamp(t + 8), AAC_FRAME));
    }
    const [videoTimeline] = generator.mpd()!.split('contentType="audio"');
    const segments = [... videoTimeline.matchAll(/<S t="(\d+)" d="(\d+)"/g)].map(([, t, d]) => [Number(t), Number(d)]);
    expect(segments).toStrictEqual([[wrap - 500, 1000], [wrap + 500, 1000], [wrap + 1500, 1000]]);
  });
});

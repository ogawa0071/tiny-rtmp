import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object, AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import type { Logger } from '../../01-tiny-rtmp-server/src/logger.mts';

import HLSGenerator from '../src/hls-generator.mts';

// FFmpeg が送ってくる AVC と AAC の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const metadata = (videocodecid: AMF0Value, audiocodecid: AMF0Value): Message => onmetadata({ videocodecid, audiocodecid });
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

describe('Tracks of codecs that this server does not put into fMP4', () => {
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

describe('Tracks decided from the sequence headers', () => {
  // yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる
  test.each([
    ['onMetaData without codec ids (yasea)', { duration: 0, width: 320, height: 240, framerate: 0, audiosamplerate: 44100, stereo: true }],
    ['no onMetaData (FFmpeg -flvflags no_metadata)', null],
  ])('%s: the tracks whose sequence headers arrive before the first frame are written', (_, object) => {
    const generator = new HLSGenerator();
    if (object != null) { generator.feed(onmetadata(object)); }
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 3000; t += 100) {
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(t + 8, AAC_FRAME));
    }
    generator.end();
    expect(trackIds(generator)).toStrictEqual(new Set([1, 2]));
  });
});

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

describe('Enhanced RTMP audio after the AAC sequence header', () => {
  // FFmpeg 8.0 以降は 5.1ch など (モノラルとステレオ以外) の AAC の初期化情報の後に、MultichannelConfig を送ってくる
  // (SoundFormat 9 の ExAudioTagHeader, AudioPacketType 4, 'mp4a', AudioChannelOrder 1 (Native), 6ch, AudioChannelMask 0x3F)
  const AAC_51_SEQUENCE_HEADER = Buffer.from('af0011b056e500', 'hex');
  const AAC_51_MULTICHANNEL_CONFIG = Buffer.from('946d70346101060000003f', 'hex');
  // FFmpeg 8.0 以降の 2 つ目の AAC の音声トラックは Multitrack (AudioPacketType 5) の OneTrack で、トラック番号 1 を付けて送ってくる
  // (初期化情報 (SequenceStart)、MultichannelConfig (1ch, FrontCenter)、フレーム (CodedFrames) の順)
  const SECOND_TRACK_SEQUENCE_START = Buffer.from('95006d70346101120856e500', 'hex');
  const SECOND_TRACK_MULTICHANNEL_CONFIG = Buffer.from('95046d70346101010100000004', 'hex');
  const SECOND_TRACK_FRAME = Buffer.from('95016d7034610121', 'hex');

  test.each([
    ['5.1ch AAC (MultichannelConfig)', [AAC_51_SEQUENCE_HEADER, AAC_51_MULTICHANNEL_CONFIG], []],
    ['2 AAC tracks (the second track is skipped)', [AAC_SEQUENCE_HEADER, SECOND_TRACK_SEQUENCE_START, SECOND_TRACK_MULTICHANNEL_CONFIG], [SECOND_TRACK_FRAME]],
  ])('FFmpeg 8.0 %s: the AAC track is kept and no audio is reported as ignored', (_, headers, others) => {
    const generator = new HLSGenerator();
    expect(warnings(() => {
      generator.feed(metadata(7, 10));
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (const header of headers) { generator.feed(audio(0, header)); }
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        generator.feed(audio(t, AAC_FRAME));
        for (const frame of others) { generator.feed(audio(t, frame)); }
      }
      generator.end();
    })).toStrictEqual([]);
    expect(trackIds(generator)).toStrictEqual(new Set([1, 2]));
  });

  test('H.264 + MP3: audio of a codec that this server does not put into fMP4 is still reported', () => {
    const generator = new HLSGenerator();
    expect(warnings(() => {
      generator.feed(metadata(7, 2));
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        generator.feed(audio(t + 8, MP3_FRAME));
      }
      generator.end();
    })).toStrictEqual(['Unsupported audio codec, audio is ignored']);
    expect(trackIds(generator)).toStrictEqual(new Set([1]));
  });
});

describe('AAC sequence header without the configuration', () => {
  test('an AAC sequence header without an AudioSpecificConfig (FFmpeg -c copy from ADTS AAC) is ignored until the real one arrives', () => {
    // FFmpeg は ADTS の AAC (MPEG-TS などの入力) を -c copy で送る時、AudioSpecificConfig が空の初期化情報 (af00) を先に送り、最初のフレームの直前に本当の初期化情報を送り直す
    const generator = new HLSGenerator();
    generator.feed(metadata(7, 10));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    generator.feed(audio(0, Buffer.from('af00', 'hex')));
    for (let t = 0; t < 3000; t += 100) {
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      if (t === 0) { generator.feed(audio(45, AAC_SEQUENCE_HEADER)); }
      generator.feed(audio(t + 45, AAC_FRAME));
    }
    generator.end();
    // 映像と音声の両方のトラックが書き出される
    expect(trackIds(generator)).toStrictEqual(new Set([1, 2]));
  });
});

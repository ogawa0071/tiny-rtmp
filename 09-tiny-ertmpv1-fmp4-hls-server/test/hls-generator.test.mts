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
  test.each([
    ['onMetaData says MP3', { videocodecid: 7, audiocodecid: 2 }],
    // onMetaData がないと、最初の MP3 のフレームが届くまで音声のトラックを待つが、その間に届いたキーフレームは取っておく
    ['no onMetaData', null],
  ])('H.264 + MP3 (%s): segments start from the first keyframe even when it arrives before the first MP3 frame', (_, object) => {
    const generator = new HLSGenerator();
    if (object != null) { generator.feed(onmetadata(object)); }
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
  ])('%s: the tracks whose sequence headers arrive within 1 second of the first frame are written', (_, object) => {
    // AVC と AAC の初期化情報が届く時刻と、書き出されるトラック
    // (yasea などは、それぞれのトラックの初期化情報をそのトラックの最初のフレームの直前に送ってくるので、もう一方のトラックの初期化情報は最初のフレームより後に届くことがある)
    // (最初のフレームから 1 秒以上たってから初期化情報が届いたトラックは書き出さない)
    const cases: [number, number, number[]][] = [
      [0, 0, [1, 2]],
      [0, 300, [1, 2]],
      [300, 0, [1, 2]],
      [0, 1500, [1]],
      [1500, 0, [2]],
    ];
    for (const [videoStart, audioStart, ids] of cases) {
      const generator = new HLSGenerator();
      if (object != null) { generator.feed(onmetadata(object)); }
      for (let t = 0; t < 5000; t += 100) {
        if (t === videoStart) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
        if (t >= videoStart) { generator.feed(video(t, avc((t - videoStart) % 1000 === 0 ? 1 : 2))); }
        if (t === audioStart) { generator.feed(audio(t, AAC_SEQUENCE_HEADER)); }
        if (t >= audioStart) { generator.feed(audio(t + 8, AAC_FRAME)); }
      }
      generator.end();
      expect(trackIds(generator)).toStrictEqual(new Set(ids));
    }
  });

  test.each([
    ['onMetaData without codec ids (yasea)', { duration: 0, width: 320, height: 240, framerate: 0, audiosamplerate: 44100, stereo: true }],
    ['no onMetaData (FFmpeg -flvflags no_metadata)', null],
  ])('%s: the frames that arrive while the other track is waited for are kept, so the first segment starts at the first keyframe', (_, object) => {
    // AAC の初期化情報が届く時刻 (null なら映像だけの配信で、音声は届かない)
    for (const audioStart of [300, null]) {
      const generator = new HLSGenerator();
      if (object != null) { generator.feed(onmetadata(object)); }
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        if (t === audioStart) { generator.feed(audio(t, AAC_SEQUENCE_HEADER)); }
        if (audioStart != null && t >= audioStart) { generator.feed(audio(t + 8, AAC_FRAME)); }
      }
      generator.end();
      // 0, 1000, 2000 ms のキーフレームから始まる 3 つのセグメントができる (最後は最後のフレームの先頭 2900 ms まで)
      expect(extinfs(generator)).toStrictEqual([1, 1, 0.9]);
      expect(trackIds(generator)).toStrictEqual(new Set(audioStart == null ? [1] : [1, 2]));
    }
  });

  test('no onMetaData and timestamps that do not advance: only the newest 1000 frames are kept while the other track is waited for', () => {
    const generator = new HLSGenerator();
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    // timestamp が進まない映像だけの配信 (配信ソフトの不具合など) では、UNDECLARED_TRACK_WAIT の間が終わらない
    for (let i = 0; i < 5000; i++) { generator.feed(video(0, avc(i % 10 === 0 ? 1 : 2))); }
    // timestamp が進んで待ち終わると、取っておいた新しい方の 1000 フレームが最初のセグメントになる
    generator.feed(video(1000, avc(1)));
    generator.end();
    expect(extinfs(generator)).toStrictEqual([1]);
    // セグメントに入っている fMP4 の断片 (moof) の数
    const [, msn] = generator.m3u8().match(/^(\d+)\.m4s$/m)!;
    expect(generator.segment(Number(msn))!.toString('latin1').split('moof').length - 1).toStrictEqual(1000);
  });

  test('an onMetaData that arrives after the first frames and declares AAC: only the frames of the last second are kept while the AAC track is waited for', () => {
    // 最初のセグメントもプレイリストに残るように、プレイリストに載せるセグメントの数を増やす
    const generator = new HLSGenerator(10);
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    for (let t = 0; t < 5000; t += 100) {
      // H.264 と AAC が書かれた onMetaData が最初のフレームより後に届き、AAC の初期化情報はさらに後に届く
      if (t === 500) { generator.feed(metadata(7, 10)); }
      if (t === 2000) { generator.feed(audio(t, AAC_SEQUENCE_HEADER)); }
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      if (t >= 2000) { generator.feed(audio(t + 8, AAC_FRAME)); }
    }
    generator.end();
    // AAC の初期化情報が届く前の 1 秒 (UNDECLARED_TRACK_WAIT) の間に取っておいた、1000 ms のキーフレームからセグメントを始める
    expect(extinfs(generator)).toStrictEqual([1, 1, 1, 0.9]);
  });

  test('a title-only onMetaData sent while waiting does not stop waiting for the AAC declared by the first onMetaData', () => {
    const generator = new HLSGenerator();
    generator.feed(metadata(7, 10));
    generator.feed(video(0, AVC_SEQUENCE_HEADER));
    // AAC の初期化情報が 2 秒遅れて届き (音声が映像より後から始まり、初期化情報を音声の最初のフレームの直前に送ってくる配信ソフトなど)、
    // それを待っている間に曲名だけを書いた onMetaData が送り直される
    // (送り直された onMetaData で決めると、コーデックが書かれていないので 1 秒 (UNDECLARED_TRACK_WAIT) しか待たず、映像だけを書き出してしまう)
    for (let t = 0; t < 4000; t += 100) {
      if (t === 500) { generator.feed(onmetadata({ title: 'next' })); }
      if (t === 2000) { generator.feed(audio(t, AAC_SEQUENCE_HEADER)); }
      generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
      if (t >= 2000) { generator.feed(audio(t + 8, AAC_FRAME)); }
    }
    generator.end();
    // 最初の onMetaData に書かれた AAC を待つので、映像と音声の両方のトラックが書き出される
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

describe('Video sequence header after the first frames', () => {
  test.each([
    ['H.264 + AAC', { videocodecid: 7, audiocodecid: 10 }, [2]],
    ['H.264 only', { videocodecid: 7 }, []],
  ])('%s: the video stays ignored after the sequence header arrives', (_, object, ids) => {
    const generator = new HLSGenerator();
    expect(warnings(() => {
      generator.feed(onmetadata(object));
      if (ids.length > 0) { generator.feed(audio(0, AAC_SEQUENCE_HEADER)); }
      for (let t = 0; t < 3000; t += 100) {
        // AVC の初期化情報が、最初のフレーム (0 ms) より後の 300 ms に届く
        if (t === 300) { generator.feed(video(t, AVC_SEQUENCE_HEADER)); }
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        if (ids.length > 0) { generator.feed(audio(t + 8, AAC_FRAME)); }
      }
      generator.end();
    })).toStrictEqual(['Video sequence header is missing, video is ignored']);

    // 映像のトラックがない配信として扱うと警告した後は、初期化情報が届いても映像を書き出さない (音声がなければ何も書き出さない)
    expect(generator.initialize()?.includes('avc1') ?? false).toBe(false);
    expect(trackIds(generator)).toStrictEqual(new Set(ids));
  });
});

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

  test('H.264 + MP3 (onMetaData says AAC but MP3 arrives): the AAC track is not waited for', () => {
    const generator = new HLSGenerator();
    expect(warnings(() => {
      generator.feed(metadata(7, 10));
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        generator.feed(audio(t + 8, MP3_FRAME));
      }
      generator.end();
    })).toStrictEqual(['Unsupported audio codec, audio is ignored']);
    expect(trackIds(generator)).toStrictEqual(new Set([1]));
    // 0 ms のキーフレームは、onMetaData に書かれた AAC を待っている間 (最初の MP3 のフレームが届くまで) に届くが、取っておいて書き出すので、0 ms のキーフレームから始める
    expect(extinfs(generator)).toStrictEqual([1, 1, 0.9]);
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
  // FFmpeg は ADTS の AAC (MPEG-TS や HLS などの入力) を -c copy で送る時、AudioSpecificConfig が空の初期化情報 (af00) を先に送り、
  // 最初の音声のフレームの直前 (最初の映像のフレームより後) に本当の初期化情報を送り直す
  // FFmpeg 8.0 以降は、その間に Enhanced RTMP の形式 (SoundFormat 9) の 5.1ch などの MultichannelConfig や、2 つ目の音声トラックの初期化情報も送ってくる
  // (FFmpeg 9.0 で MPEG-TS の入力を -c copy で送った時のバイト列。2 つ目の音声トラックは、最初の映像のフレームの後にも届く)
  test.each<[string, string[], string[]]>([
    ['stereo', ['af00'], []],
    ['5.1ch (MultichannelConfig)', ['af00', '946d70346101060000003f'], []],
    ['2 AAC tracks (Multitrack)', ['af00', '95006d70346101', '95046d70346101010200000003'], ['95006d703461011210', '95046d70346101010200000003', '95016d7034610121']],
    ['AAC + Opus tracks (Multitrack)', ['af00', '95004f707573014f707573486561640102000080bb0000000000', '95044f70757301010200000003'], ['95014f70757301fc']],
  ])('FFmpeg -c copy from ADTS AAC, %s: the AAC track is waited for, with or without onMetaData, the first segment starts at the first keyframe, and no audio is reported as ignored', (_, beforeVideo, afterVideo) => {
    for (const object of [{ videocodecid: 7, audiocodecid: 10 }, null]) {
      const generator = new HLSGenerator();
      expect(warnings(() => {
        if (object != null) { generator.feed(onmetadata(object)); }
        generator.feed(video(0, AVC_SEQUENCE_HEADER));
        for (const hex of beforeVideo) { generator.feed(audio(0, Buffer.from(hex, 'hex'))); }
        for (let t = 0; t < 3000; t += 100) {
          generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
          if (t === 0) {
            for (const hex of afterVideo) { generator.feed(audio(43, Buffer.from(hex, 'hex'))); }
            generator.feed(audio(45, AAC_SEQUENCE_HEADER));
          }
          generator.feed(audio(t + 45, AAC_FRAME));
        }
        generator.end();
      })).toStrictEqual([]);
      // 映像と音声の両方のトラックが書き出される
      expect(trackIds(generator)).toStrictEqual(new Set([1, 2]));
      // 本当の AAC の初期化情報より先に届いた 0 ms のキーフレームから、1000, 2000 ms のキーフレームから始まるセグメントと合わせて 3 つのセグメントができる
      expect(extinfs(generator)).toStrictEqual([1, 1, 0.9]);
    }
  });
});

describe('Enhanced RTMP video of the second track', () => {
  // FFmpeg 8.0 以降の 2 つ目の映像トラックは Multitrack (PacketType 6) の OneTrack で、トラック番号 1 を付けて送ってくる
  // (ExVideoTagHeader の 1 byte の後に、AvMultitrackType (OneTrack は 0) と PacketType (0 は SequenceStart, 1 は CodedFrames) の 1 byte, 'avc1', トラック番号 1 が続く)
  const SECOND_TRACK_SEQUENCE_START = Buffer.concat([Buffer.from('96006176633101', 'hex'), AVC_SEQUENCE_HEADER.subarray(5)]);
  const second_track = (frameType: number): Buffer => Buffer.from([0x80 | (frameType << 4) | 6, 1, 0x61, 0x76, 0x63, 0x31, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);

  test('FFmpeg 8.0 2 video tracks: the first track is used and no video is reported as ignored', () => {
    const generator = new HLSGenerator();
    expect(warnings(() => {
      generator.feed(metadata(7, 10));
      generator.feed(video(0, AVC_SEQUENCE_HEADER));
      generator.feed(video(0, SECOND_TRACK_SEQUENCE_START));
      generator.feed(audio(0, AAC_SEQUENCE_HEADER));
      for (let t = 0; t < 3000; t += 100) {
        generator.feed(video(t, avc(t % 1000 === 0 ? 1 : 2)));
        generator.feed(video(t, second_track(t % 1000 === 0 ? 1 : 2)));
        generator.feed(audio(t, AAC_FRAME));
      }
      generator.end();
    })).toStrictEqual([]);
    expect(extinfs(generator)).toStrictEqual([1, 1, 0.9]);
    expect(trackIds(generator)).toStrictEqual(new Set([1, 2]));
  });

  test('FFmpeg 8.0 2 video tracks from an encoder without a global header: the first track is waited for even when audio arrives first', () => {
    // FFmpeg は最初の映像トラックの中身が空の初期化情報を先に送り、最初のフレームの直前に本当の初期化情報を送り直す
    const generator = new HLSGenerator();
    generator.feed(metadata(7, 10));
    generator.feed(video(0, Buffer.from('1700000000', 'hex')));
    generator.feed(video(0, SECOND_TRACK_SEQUENCE_START));
    generator.feed(audio(0, AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 300; t += 20) { generator.feed(audio(t, AAC_FRAME)); }
    generator.feed(video(300, AVC_SEQUENCE_HEADER));
    for (let t = 300; t < 3300; t += 100) {
      generator.feed(video(t, avc((t - 300) % 1000 === 0 ? 1 : 2)));
      generator.feed(video(t, second_track((t - 300) % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(t, AAC_FRAME));
    }
    generator.end();
    // 映像と音声の両方のトラックが書き出され、最初の映像トラックのキーフレーム (300, 1300, 2300 ms) でセグメントが区切られる
    expect(trackIds(generator)).toStrictEqual(new Set([1, 2]));
    expect(extinfs(generator)).toStrictEqual([1, 1, 0.9]);
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
    generator.feed(metadata(7, 10));
    generator.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
    generator.feed(audio(timestamp(0), AAC_SEQUENCE_HEADER));
    for (let t = 0; t < 6000; t += 100) {
      generator.feed(video(timestamp(t), avc(t % 1000 === 0 ? 1 : 2)));
      generator.feed(audio(timestamp(t + 8), AAC_FRAME));
    }
    generator.end();
    // 一周した後も 0, 1000, ..., 5000 ms のキーフレームからセグメントができる (最後は最後のフレームの先頭 5900 ms まで、プレイリストには最後の 4 つが載る)
    expect(extinfs(generator)).toStrictEqual([1, 1, 1, 0.9]);
  });
});

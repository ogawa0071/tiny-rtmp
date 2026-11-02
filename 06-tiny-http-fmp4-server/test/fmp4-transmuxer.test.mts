import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object, AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { NoopLogger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import FMP4Transmuxer from '../src/fmp4-transmuxer.mts';
import type { FMP4Fragment } from '../src/fmp4-transmuxer.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');

const onmetadata = (object: AMF0Object, timestamp: number = 0): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp, data: ['@setDataFrame', 'onMetaData', object],
});
const metadata = (videocodecid: AMF0Value, audiocodecid: AMF0Value): Message => onmetadata({ videocodecid, audiocodecid });
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、Sorenson H.263 (CodecID 2) のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const SORENSON_FRAME = Buffer.from('2200000000', 'hex');
// AAC と MP3 (SoundFormat 2) のフレーム
const AAC_FRAME = Buffer.from('af0121', 'hex');
const MP3_FRAME = Buffer.from('2fff', 'hex');
// FFmpeg 8.0 の 5.1ch の AAC の初期化情報と、その後に送られる Enhanced RTMP の MultichannelConfig (SoundFormat 9)
const AAC_51_SEQUENCE_HEADER = Buffer.from('af00123056e500', 'hex');
const MULTICHANNEL_CONFIG = Buffer.from('946d70346101060000060f', 'hex');

// yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる
const YASEA_ONMETADATA = { duration: 0, width: 320, height: 240, videodatarate: 0, framerate: 0, audiodatarate: 0, audiosamplerate: 44100, audiosamplesize: 16, stereo: true, filesize: 0 };

// 3 秒間、10 fps の映像 (1 秒ごとにキーフレーム) と、100 ミリ秒ごとの音声のフレームを送って、できた fMP4 の断片を返す
const publish = (transmuxer: FMP4Transmuxer, { videoFrame, audioFrame, before }: { videoFrame?: (t: number) => Buffer; audioFrame?: Buffer; before?: (t: number) => void; }): FMP4Fragment[] => {
  const fragments: FMP4Fragment[] = [];
  for (let t = 0; t < 3000; t += 100) {
    before?.(t);
    if (videoFrame != null) { fragments.push(... transmuxer.feed(video(t, videoFrame(t)))); }
    if (audioFrame != null) { fragments.push(... transmuxer.feed(audio(t + 8, audioFrame))); }
  }
  return fragments;
};
const keyframes = (t: number): Buffer => avc(t % 1000 === 0 ? 1 : 2);

// 初期化セグメントに入っているトラック (サンプルエントリの種類)
const tracks = (transmuxer: FMP4Transmuxer): string[] => {
  const initialize = transmuxer.initialize();
  if (initialize == null) { return []; }
  return ['avc1', 'mp4a'].filter((type) => initialize.includes(type));
};
// fMP4 の断片に入っているトラックの番号 (tfhd の track_ID)
const trackId = ({ data }: FMP4Fragment): number => {
  // tfhd: size (4byte), 'tfhd' (4byte), version と flags (4byte), track_ID (4byte)
  return data.readUInt32BE(data.indexOf('tfhd') + 8);
};
const trackIds = (fragments: FMP4Fragment[]): Set<number> => new Set(fragments.map(trackId));
// fMP4 の断片の最初のサンプルの時刻
const decodeTime = ({ data }: FMP4Fragment): number => {
  // tfdt (version 1): size (4byte), 'tfdt' (4byte), version と flags (4byte), baseMediaDecodeTime (8byte)
  return Number(data.readBigUInt64BE(data.indexOf('tfdt') + 8));
};

describe('Tracks in the initialization segment', () => {
  test.each([
    // FFmpeg の FLV の既定の音声は MP3 なので、-c:v libx264 だけを指定すると H.264 + MP3 になる
    ['onMetaData says MP3', 2],
    ['onMetaData says AAC but MP3 arrives', 10],
  ])('H.264 + MP3 (%s): the video is sent without waiting for the audio', (_, audiocodecid) => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(7, audiocodecid));
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    const fragments = publish(transmuxer, { videoFrame: keyframes, audioFrame: MP3_FRAME });

    expect(tracks(transmuxer)).toStrictEqual(['avc1']);
    expect(trackIds(fragments)).toStrictEqual(new Set([1]));
  });

  test('Sorenson H.263 + AAC: the audio is sent without waiting for the video, and every audio fragment can start playback', () => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(2, 10));
    transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER));
    const fragments = publish(transmuxer, { videoFrame: () => SORENSON_FRAME, audioFrame: AAC_FRAME });

    expect(tracks(transmuxer)).toStrictEqual(['mp4a']);
    expect(trackIds(fragments)).toStrictEqual(new Set([2]));
    expect(fragments.every(({ independent }) => independent)).toBe(true);
  });

  test.each([
    ['onMetaData without codec ids (yasea)', YASEA_ONMETADATA],
    ['no onMetaData (FFmpeg -flvflags no_metadata)', null],
  ])('%s: the tracks are decided from the sequence headers that arrive within 1 second of the first frame', (_, object) => {
    // AVC と AAC の初期化情報が届く時刻と、初期化セグメントに入るトラック
    // (yasea などは、それぞれのトラックの初期化情報をそのトラックの最初のフレームの直前に送ってくるので、もう一方のトラックの初期化情報は最初のフレームより後に届くことがある)
    // (最初のフレームから 1 秒以上たってから初期化情報が届いたトラックは、初期化セグメントにないので送らない)
    const cases: [number, number, string[], number[]][] = [
      [0, 0, ['avc1', 'mp4a'], [1, 2]],
      [0, 500, ['avc1', 'mp4a'], [1, 2]],
      [300, 0, ['avc1', 'mp4a'], [1, 2]],
      [0, 1500, ['avc1'], [1]],
      [1500, 0, ['mp4a'], [2]],
    ];
    for (const [videoStart, audioStart, expected, ids] of cases) {
      const transmuxer = new FMP4Transmuxer();
      if (object != null) { transmuxer.feed(onmetadata(object)); }
      const fragments: FMP4Fragment[] = [];
      for (let t = 0; t < 4000; t += 100) {
        if (t === videoStart) { transmuxer.feed(video(t, AVC_SEQUENCE_HEADER)); }
        if (t >= videoStart) { fragments.push(... transmuxer.feed(video(t, keyframes(t - videoStart)))); }
        if (t === audioStart) { transmuxer.feed(audio(t, AAC_SEQUENCE_HEADER)); }
        if (t >= audioStart) { fragments.push(... transmuxer.feed(audio(t + 8, AAC_FRAME))); }
      }

      expect(tracks(transmuxer)).toStrictEqual(expected);
      expect(trackIds(fragments)).toStrictEqual(new Set(ids));
    }
  });

  test.each([
    ['onMetaData without codec ids (yasea)', YASEA_ONMETADATA],
    ['no onMetaData (FFmpeg -flvflags no_metadata)', null],
  ])('%s: the frames that arrive while the other track is waited for are kept, so viewers can start from the first keyframe', (_, object) => {
    // AAC の初期化情報が届く時刻 (null なら映像だけの配信で、音声は届かない)
    for (const audioStart of [300, null]) {
      const transmuxer = new FMP4Transmuxer();
      if (object != null) { transmuxer.feed(onmetadata(object)); }
      transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
      const fragments: FMP4Fragment[] = [];
      for (let t = 0; t < 3000; t += 100) {
        fragments.push(... transmuxer.feed(video(t, keyframes(t))));
        if (t === audioStart) { transmuxer.feed(audio(t, AAC_SEQUENCE_HEADER)); }
        if (audioStart != null && t >= audioStart) { fragments.push(... transmuxer.feed(audio(t + 8, AAC_FRAME))); }
      }

      // 0 ms のキーフレームから、全ての映像のフレームが送られる (最後のフレームは長さが分からないので、まだ送られない)
      const videoFragments = fragments.filter((fragment) => trackId(fragment) === 1);
      expect(videoFragments.map(decodeTime)).toStrictEqual(Array.from({ length: 29 }, (_, i) => i * 100));
      expect(fragments.find(({ independent }) => independent)).toBe(videoFragments[0]);
    }
  });

  test('no onMetaData and timestamps that do not advance: only the newest 1000 frames are kept while the other track is waited for', () => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    // timestamp が進まない映像だけの配信 (配信ソフトの不具合など) では、UNDECLARED_TRACK_WAIT の間が終わらない
    const waiting: FMP4Fragment[] = [];
    for (let i = 0; i < 5000; i++) { waiting.push(... transmuxer.feed(video(0, keyframes(i * 100)))); }
    expect(waiting).toStrictEqual([]);

    // timestamp が進んで待ち終わると、取っておいた新しい方の 1000 フレームが送られる (いま届いたフレームは長さが分からないので、まだ送られない)
    const fragments = transmuxer.feed(video(1000, keyframes(0)));
    expect(fragments.length).toStrictEqual(1000);
  });

  test('an onMetaData that arrives after the first frames and declares AAC: only the frames of the last second and those from the newest keyframe are kept while the AAC track is waited for', () => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    const fragments: FMP4Fragment[] = [];
    for (let t = 0; t < 3000; t += 100) {
      // H.264 と AAC が書かれた onMetaData が最初のフレームより後に届き、AAC の初期化情報はさらに後に届く
      if (t === 500) { transmuxer.feed(metadata(7, 10)); }
      if (t === 2000) { transmuxer.feed(audio(t, AAC_SEQUENCE_HEADER)); }
      fragments.push(... transmuxer.feed(video(t, keyframes(t))));
      if (t >= 2000) { fragments.push(... transmuxer.feed(audio(t + 8, AAC_FRAME))); }
    }

    // 映像は、一番新しいキーフレーム (1000 ms) から送られる (それより前の 0 ms からの GOP は、AAC の初期化情報が届く 1 秒 (UNDECLARED_TRACK_WAIT) より前に届いたので取っておかない)
    const videoFragments = fragments.filter((fragment) => trackId(fragment) === 1);
    expect(videoFragments.map(decodeTime)).toStrictEqual(Array.from({ length: 19 }, (_, i) => 1000 + i * 100));
    expect(fragments.find(({ independent }) => independent)).toBe(videoFragments[0]);
  });

  test.each([
    ['Sorenson H.263', SORENSON_FRAME],
    ['Enhanced RTMP H.265', Buffer.from('9168766331000000', 'hex')],
  ])('no onMetaData, %s + AAC: the audio is sent from the first frame without waiting for an H.264 sequence header', (_, frame) => {
    const transmuxer = new FMP4Transmuxer();
    // 最初に届いた映像が H.264 ではないので、H.264 の初期化情報は待たない
    const fragments = publish(transmuxer, { videoFrame: () => frame, audioFrame: AAC_FRAME, before: (t) => {
      if (t === 0) { transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER)); }
      // 最初の AAC のフレーム (8 ms) を受け取った時には、もう初期化セグメントができている (UNDECLARED_TRACK_WAIT の 1 秒を待たない)
      if (t === 100) { expect(transmuxer.initialize()).not.toBeNull(); }
    } });

    expect(tracks(transmuxer)).toStrictEqual(['mp4a']);
    // 最初の AAC のフレーム (8 ms) から、全ての AAC のフレームが送られる
    expect(fragments.length).toStrictEqual(30);
    expect(decodeTime(fragments[0])).toStrictEqual(Math.floor(8 * 44100 / 1000));
  });

  test('no onMetaData, an empty AVC sequence header first (FFmpeg 6.1 or later, encoder without global header): the real one that arrives later is waited for, and the AAC frames that arrive until then are kept', () => {
    const transmuxer = new FMP4Transmuxer();
    // 配信の始めに中身が空の AVC の初期化情報と AAC の初期化情報が届き、本当の AVC の初期化情報は最初の映像のフレーム (300 ms) の直前に届く
    // (エンコーダの遅延で、最初の映像のフレームより先に AAC のフレームが届く。それは映像の初期化情報を待っている間に届くが、取っておいて、初期化セグメントを作った時に fMP4 の断片にする)
    transmuxer.feed(video(0, Buffer.from('1700000000', 'hex')));
    transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER));
    const fragments: FMP4Fragment[] = [];
    for (let t = 0; t < 3000; t += 100) {
      if (t === 300) { transmuxer.feed(video(t, AVC_SEQUENCE_HEADER)); }
      if (t >= 300) { fragments.push(... transmuxer.feed(video(t, keyframes(t - 300)))); }
      fragments.push(... transmuxer.feed(audio(t + 8, AAC_FRAME)));
    }

    expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
    expect(trackIds(fragments)).toStrictEqual(new Set([1, 2]));
    // 映像の初期化情報を待っている間に届いた 8 ms のフレームから、全ての AAC のフレームが fMP4 の断片になる
    expect(fragments.filter((fragment) => trackId(fragment) === 2).map(decodeTime)).toStrictEqual(Array.from({ length: 30 }, (_, i) => Math.floor((8 + i * 100) * 44100 / 1000)));
  });

  test('no onMetaData, H.264 + MP3: the keyframe that arrives before the first MP3 frame is sent too', () => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    // FFmpeg は、最初の映像のキーフレーム (0 ms) の後に最初の MP3 のフレーム (8 ms) を送ってくる (MP3 には初期化情報がない)
    const fragments = publish(transmuxer, { videoFrame: keyframes, audioFrame: MP3_FRAME });

    expect(tracks(transmuxer)).toStrictEqual(['avc1']);
    expect(fragments.map(decodeTime)).toStrictEqual(Array.from({ length: 29 }, (_, i) => i * 100));
    expect(fragments[0].independent).toStrictEqual(true);
  });

  test.each([
    ['onMetaData with H.264 and AAC', { videocodecid: 7, audiocodecid: 10 }],
    ['no onMetaData', null],
  ])('H.264 whose real sequence header never arrives (FFmpeg 6.0 or earlier), %s: the video is reported as ignored and every AAC frame is sent', (_, object) => {
    const warnings: string[] = [];
    registerLogger(Object.assign(new NoopLogger(), { warn: (message: string) => { warnings.push(message); } }));
    const transmuxer = new FMP4Transmuxer();
    try {
      if (object != null) { transmuxer.feed(onmetadata(object)); }
      // 中身が空の初期化情報だけが届き、H.264 のフレームは開始コード付き (Annex B) のまま届く
      transmuxer.feed(video(0, Buffer.from('1700000000', 'hex')));
      transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER));
      const fragments = publish(transmuxer, { videoFrame: (t) => Buffer.concat([avc(t % 1000 === 0 ? 1 : 2).subarray(0, 5), Buffer.from('0000000165', 'hex')]), audioFrame: AAC_FRAME });

      expect(warnings).toStrictEqual(['Video sequence header is missing, video is ignored']);
      expect(tracks(transmuxer)).toStrictEqual(['mp4a']);
      expect(trackIds(fragments)).toStrictEqual(new Set([2]));
      // 映像のない配信なので、どの音声の断片からも送り始められる
      expect(fragments.length).toStrictEqual(30);
      expect(fragments.every(({ independent }) => independent)).toStrictEqual(true);
    } finally {
      registerLogger(new NoopLogger());
    }
  });

  test.each([
    ['H.264 + AAC', { videocodecid: 7, audiocodecid: 10 }, ['mp4a']],
    ['H.264 only', { videocodecid: 7 }, []],
  ])('%s whose sequence header arrives after the first frames: the video stays ignored after the sequence header arrives', (_, object, expected) => {
    const warnings: string[] = [];
    registerLogger(Object.assign(new NoopLogger(), { warn: (message: string) => { warnings.push(message); } }));
    const transmuxer = new FMP4Transmuxer();
    try {
      transmuxer.feed(onmetadata(object));
      const audioFrame = expected.length > 0 ? AAC_FRAME : undefined;
      if (audioFrame != null) { transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER)); }
      // AVC の初期化情報が、最初のフレーム (0 ms) より後の 300 ms に届く
      const fragments = publish(transmuxer, { videoFrame: keyframes, audioFrame, before: (t) => {
        if (t === 300) { transmuxer.feed(video(t, AVC_SEQUENCE_HEADER)); }
      } });

      // 映像のトラックがない配信として扱うと警告した後は、初期化情報が届いても映像を送らない (音声がなければ何も送らない)
      expect(warnings).toStrictEqual(['Video sequence header is missing, video is ignored']);
      expect(tracks(transmuxer)).toStrictEqual(expected);
      expect(trackIds(fragments)).toStrictEqual(new Set(expected.length > 0 ? [2] : []));
    } finally {
      registerLogger(new NoopLogger());
    }
  });

  test('Enhanced RTMP audio after the AAC sequence header (MultichannelConfig) does not stop the AAC track', () => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(7, 10));
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    transmuxer.feed(audio(0, AAC_51_SEQUENCE_HEADER));
    transmuxer.feed(audio(0, MULTICHANNEL_CONFIG));
    const fragments = publish(transmuxer, { videoFrame: keyframes, audioFrame: AAC_FRAME });

    expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
    expect(trackIds(fragments)).toStrictEqual(new Set([1, 2]));
  });

  test.each<[AMF0Value, AMF0Value]>([
    [7, 10],
    // コーデックを数値ではなく 'avc1' や 'mp4a' の文字列で送ってくる配信ソフトもある
    ['avc1', 'mp4a'],
  ])('onMetaData with %s and %s, sent again before the first frame without the codecs: the declared AAC is still waited for', (videocodecid, audiocodecid) => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(videocodecid, audiocodecid));
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    // 最初のフレームより前に、曲名だけを書いた onMetaData が送り直される
    transmuxer.feed(onmetadata({ title: 'next' }));
    const fragments: FMP4Fragment[] = [];
    for (let t = 0; t < 3000; t += 100) {
      fragments.push(... transmuxer.feed(video(t, keyframes(t))));
      // AAC の初期化情報は、音声が始まる 2 秒 (最初の AAC のフレームの直前) に届く
      // (送り直された onMetaData で決めると、コーデックが書かれていないので 1 秒 (UNDECLARED_TRACK_WAIT) しか待たず、映像だけになってしまう)
      if (t === 2000) { transmuxer.feed(audio(t + 45, AAC_SEQUENCE_HEADER)); }
      if (t >= 2000) { fragments.push(... transmuxer.feed(audio(t + 45, AAC_FRAME))); }
    }

    expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
    expect(trackIds(fragments)).toStrictEqual(new Set([1, 2]));
  });

  test('an onMetaData sent again during the publish does not change where viewers can start', () => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(7, 10));
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    transmuxer.feed(audio(0, AAC_SEQUENCE_HEADER));
    // 曲名だけを書いた onMetaData が送り直されても、映像のある配信なので、視聴者は映像のキーフレームから見始める
    const fragments = publish(transmuxer, { videoFrame: keyframes, audioFrame: AAC_FRAME, before: (t) => {
      if (t === 1500) { transmuxer.feed(onmetadata({ title: 'next' }, t)); }
    } });

    const audioFragments = fragments.filter((fragment) => trackId(fragment) === 2);
    expect(audioFragments.length).toBeGreaterThan(0);
    expect(audioFragments.some(({ independent }) => independent)).toBe(false);
  });
});

describe('Sequence headers without the configuration', () => {
  // FFmpeg は、配信を始める時にまだ初期化情報がないと、中身が空の初期化情報を先に送り、そのトラックの最初のフレームの直前に本当の初期化情報を送り直す
  // そのため、もう一方のトラックのフレームが、本当の初期化情報より先に届くことがある (FFmpeg 6.1 で確かめた順番で送る)
  test.each([
    // B フレームのある H.264 と ADTS の AAC (MPEG-TS などの入力) を -c copy で送る時は、映像のキーフレームが先に届く
    ['AAC (FFmpeg -c copy from ADTS AAC)', AVC_SEQUENCE_HEADER, Buffer.from('af00', 'hex'), 0, 45],
    // B フレームのない H.264 を -flags -global_header で AAC と送る時は、AAC のフレームが先に届く
    ['AVC (FFmpeg with an encoder that does not output a global header)', Buffer.from('1700000000', 'hex'), AAC_SEQUENCE_HEADER, 23, 0],
  ])('%s: the empty sequence header is ignored until the real one arrives', (_, videoHeader, audioHeader, videoStart, audioStart) => {
    // onMetaData のコーデックが数値の時と、'avc1' や 'mp4a' の文字列の時
    const codecs: [AMF0Value, AMF0Value][] = [[7, 10], ['avc1', 'mp4a']];
    for (const [videocodecid, audiocodecid] of codecs) {
      const transmuxer = new FMP4Transmuxer();
      transmuxer.feed(metadata(videocodecid, audiocodecid));
      transmuxer.feed(video(0, videoHeader));
      transmuxer.feed(audio(0, audioHeader));
      // 本当の初期化情報をそのトラックの最初のフレームの直前に置いて、timestamp 順に送る
      const messages = [
        video(videoStart, AVC_SEQUENCE_HEADER),
        ... Array.from({ length: 30 }, (_, i) => video(videoStart + i * 100, keyframes(i * 100))),
        audio(audioStart, AAC_SEQUENCE_HEADER),
        ... Array.from({ length: 30 }, (_, i) => audio(audioStart + i * 100, AAC_FRAME)),
      ].sort((a, b) => a.timestamp - b.timestamp);
      const fragments = messages.flatMap((message) => transmuxer.feed(message));

      expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
      expect(trackIds(fragments)).toStrictEqual(new Set([1, 2]));
    }
  });

  // FFmpeg 9.0 が ADTS の AAC (MPEG-TS や HLS などの入力) を -c copy で送った時に、本当の AAC の初期化情報より前に届く音声のメッセージ
  // 最初の映像のフレームより前に、中身が空の AAC の初期化情報 (af00) と、(FFmpeg 8.0 以降は) Enhanced RTMP の形式 (SoundFormat 9) の
  // 5.1ch などの MultichannelConfig や、2 つ目の音声トラックの初期化情報が届く。2 つ目の音声トラックは、最初の映像のフレームの後にも届く
  test.each<[string, string[], string[]]>([
    ['stereo', ['af00'], []],
    ['5.1ch (MultichannelConfig)', ['af00', '946d70346101060000003f'], []],
    ['2 AAC tracks (Multitrack)', ['af00', '95006d70346101', '95046d70346101010200000003'], ['95006d703461011210', '95046d70346101010200000003', '95016d7034610121']],
    ['AAC + Opus tracks (Multitrack)', ['af00', '95004f707573014f707573486561640102000080bb0000000000', '95044f70757301010200000003'], ['95014f70757301fc']],
  ])('FFmpeg -c copy from ADTS AAC, %s: the AAC track is waited for, with or without onMetaData, and viewers can start from the first keyframe', (_, beforeVideo, afterVideo) => {
    for (const object of [{ videocodecid: 7, audiocodecid: 10 }, null]) {
      const transmuxer = new FMP4Transmuxer();
      if (object != null) { transmuxer.feed(onmetadata(object)); }
      transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
      for (const hex of beforeVideo) { transmuxer.feed(audio(0, Buffer.from(hex, 'hex'))); }
      const fragments: FMP4Fragment[] = [];
      for (let t = 0; t < 3000; t += 100) {
        fragments.push(... transmuxer.feed(video(t, keyframes(t))));
        // 本当の初期化情報は、最初の音声のフレームの直前 (最初の映像のフレームより後) に届く
        if (t === 0) {
          for (const hex of afterVideo) { transmuxer.feed(audio(43, Buffer.from(hex, 'hex'))); }
          transmuxer.feed(audio(45, AAC_SEQUENCE_HEADER));
        }
        fragments.push(... transmuxer.feed(audio(t + 45, AAC_FRAME)));
      }

      expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
      expect(trackIds(fragments)).toStrictEqual(new Set([1, 2]));
      // 本当の AAC の初期化情報より先に届いた 0 ms のキーフレームから、全ての映像のフレームが送られる (最後のフレームは長さが分からないので、まだ送られない)
      const videoFragments = fragments.filter((fragment) => trackId(fragment) === 1);
      expect(videoFragments.map(decodeTime)).toStrictEqual(Array.from({ length: 29 }, (_, i) => i * 100));
      expect(fragments.find(({ independent }) => independent)).toBe(videoFragments[0]);
    }
  });

  test.each([
    // 1500 ms に届けば 0 ms のキーフレームから、3500 ms に届けば 2000 ms のキーフレームから送られる (それより前の GOP は取っておかない)
    [1500, 0],
    [3500, 2000],
  ])('FFmpeg -c copy from ADTS AAC whose audio starts later, 2-second GOP, the real AAC sequence header at %i ms: viewers can start from the newest keyframe before it (%i ms)', (header, start) => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(7, 10));
    transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
    transmuxer.feed(audio(0, Buffer.from('af00', 'hex')));
    const fragments: FMP4Fragment[] = [];
    for (let t = 0; t < 6000; t += 100) {
      // GOP が UNDECLARED_TRACK_WAIT (1 秒) より長いので、本当の AAC の初期化情報が届く前の 1 秒には映像のキーフレームがない
      if (t === header) { transmuxer.feed(audio(t, AAC_SEQUENCE_HEADER)); }
      fragments.push(... transmuxer.feed(video(t, avc(t % 2000 === 0 ? 1 : 2))));
      if (t >= header) { fragments.push(... transmuxer.feed(audio(t + 8, AAC_FRAME))); }
    }

    // 最後のフレーム (5900 ms) は長さが分からないので、まだ送られない
    const videoFragments = fragments.filter((fragment) => trackId(fragment) === 1);
    expect(videoFragments.map(decodeTime)).toStrictEqual(Array.from({ length: (5900 - start) / 100 }, (_, i) => start + i * 100));
    expect(fragments.find(({ independent }) => independent)).toBe(videoFragments[0]);
  });
});

describe('RTMP timestamps that wrap around', () => {
  test.each([
    ['the RTMP specification (32bit)', 2 ** 32],
    ['FFmpeg (31bit)', 2 ** 31],
  ])('the decode time of the video keeps increasing after the timestamps of %s wrap around', (_, wrap) => {
    const transmuxer = new FMP4Transmuxer();
    // 配信を始めてから 1.5 秒後に timestamp が一周して 0 に戻る
    const timestamp = (t: number): number => (wrap - 1500 + t) % wrap;
    transmuxer.feed(metadata(7, 0));
    transmuxer.feed(video(timestamp(0), AVC_SEQUENCE_HEADER));
    const fragments: FMP4Fragment[] = [];
    for (let t = 0; t < 3000; t += 100) {
      fragments.push(... transmuxer.feed(video(timestamp(t), keyframes(t))));
    }
    expect(fragments.map(decodeTime)).toStrictEqual(Array.from({ length: 29 }, (_, i) => wrap - 1500 + i * 100));
  });
});

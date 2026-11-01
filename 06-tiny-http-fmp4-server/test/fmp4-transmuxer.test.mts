import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object, AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

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
  const fragments: (FMP4Fragment | null)[] = [];
  for (let t = 0; t < 3000; t += 100) {
    before?.(t);
    if (videoFrame != null) { fragments.push(transmuxer.feed(video(t, videoFrame(t)))); }
    if (audioFrame != null) { fragments.push(transmuxer.feed(audio(t + 8, audioFrame))); }
  }
  return fragments.filter((fragment) => fragment != null);
};
const keyframes = (t: number): Buffer => avc(t % 1000 === 0 ? 1 : 2);

// 初期化セグメントに入っているトラック (サンプルエントリの種類)
const tracks = (transmuxer: FMP4Transmuxer): string[] => {
  const initialize = transmuxer.initialize();
  if (initialize == null) { return []; }
  return ['avc1', 'mp4a'].filter((type) => initialize.includes(type));
};
// fMP4 の断片に入っているトラックの番号 (tfhd の track_ID)
const trackIds = (fragments: FMP4Fragment[]): Set<number> => {
  // tfhd: size (4byte), 'tfhd' (4byte), version と flags (4byte), track_ID (4byte)
  return new Set(fragments.map(({ data }) => data.readUInt32BE(data.indexOf('tfhd') + 8)));
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
      const fragments: (FMP4Fragment | null)[] = [];
      for (let t = 0; t < 4000; t += 100) {
        if (t === videoStart) { transmuxer.feed(video(t, AVC_SEQUENCE_HEADER)); }
        if (t >= videoStart) { fragments.push(transmuxer.feed(video(t, keyframes(t - videoStart)))); }
        if (t === audioStart) { transmuxer.feed(audio(t, AAC_SEQUENCE_HEADER)); }
        if (t >= audioStart) { fragments.push(transmuxer.feed(audio(t + 8, AAC_FRAME))); }
      }

      expect(tracks(transmuxer)).toStrictEqual(expected);
      expect(trackIds(fragments.filter((fragment) => fragment != null))).toStrictEqual(new Set(ids));
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
    const fragments: (FMP4Fragment | null)[] = [];
    for (let t = 0; t < 3000; t += 100) {
      fragments.push(transmuxer.feed(video(t, keyframes(t))));
      // AAC の初期化情報は、最初の映像のフレームより後 (最初の AAC のフレームの直前) に届く
      if (t === 0) { transmuxer.feed(audio(t + 45, AAC_SEQUENCE_HEADER)); }
      fragments.push(transmuxer.feed(audio(t + 45, AAC_FRAME)));
    }

    expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
    expect(trackIds(fragments.filter((fragment) => fragment != null))).toStrictEqual(new Set([1, 2]));
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

    const audioFragments = fragments.filter(({ data }) => data.readUInt32BE(data.indexOf('tfhd') + 8) === 2);
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
      const fragments = messages.map((message) => transmuxer.feed(message));

      expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
      expect(trackIds(fragments.filter((fragment) => fragment != null))).toStrictEqual(new Set([1, 2]));
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
  ])('FFmpeg -c copy from ADTS AAC, %s: the AAC track is waited for, with or without onMetaData', (_, beforeVideo, afterVideo) => {
    for (const object of [{ videocodecid: 7, audiocodecid: 10 }, null]) {
      const transmuxer = new FMP4Transmuxer();
      if (object != null) { transmuxer.feed(onmetadata(object)); }
      transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
      for (const hex of beforeVideo) { transmuxer.feed(audio(0, Buffer.from(hex, 'hex'))); }
      const fragments: (FMP4Fragment | null)[] = [];
      for (let t = 0; t < 3000; t += 100) {
        fragments.push(transmuxer.feed(video(t, keyframes(t))));
        // 本当の初期化情報は、最初の音声のフレームの直前 (最初の映像のフレームより後) に届く
        if (t === 0) {
          for (const hex of afterVideo) { transmuxer.feed(audio(43, Buffer.from(hex, 'hex'))); }
          transmuxer.feed(audio(45, AAC_SEQUENCE_HEADER));
        }
        fragments.push(transmuxer.feed(audio(t + 45, AAC_FRAME)));
      }

      expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
      expect(trackIds(fragments.filter((fragment) => fragment != null))).toStrictEqual(new Set([1, 2]));
    }
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
      const fragment = transmuxer.feed(video(timestamp(t), keyframes(t)));
      if (fragment != null) { fragments.push(fragment); }
    }
    // tfdt (version 1): size (4byte), 'tfdt' (4byte), version と flags (4byte), baseMediaDecodeTime (8byte)
    const decodeTimes = fragments.map(({ data }) => Number(data.readBigUInt64BE(data.indexOf('tfdt') + 8)));
    expect(decodeTimes).toStrictEqual(Array.from({ length: 29 }, (_, i) => wrap - 1500 + i * 100));
  });
});

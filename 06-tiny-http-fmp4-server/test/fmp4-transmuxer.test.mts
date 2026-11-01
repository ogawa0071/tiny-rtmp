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
  ])('%s: the tracks are decided from the sequence headers that arrive before the first frame', (_, object) => {
    // AAC の初期化情報が届く時刻と、初期化セグメントに入るトラック
    // (最初のフレームより後に初期化情報が届いた音声は、初期化セグメントにないので送らない)
    const cases: [number, string[], number[]][] = [
      [0, ['avc1', 'mp4a'], [1, 2]],
      [500, ['avc1'], [1]],
    ];
    for (const [audioStart, expected, ids] of cases) {
      const transmuxer = new FMP4Transmuxer();
      if (object != null) { transmuxer.feed(onmetadata(object)); }
      transmuxer.feed(video(0, AVC_SEQUENCE_HEADER));
      const fragments: (FMP4Fragment | null)[] = [];
      for (let t = 0; t < 3000; t += 100) {
        if (t === audioStart) { transmuxer.feed(audio(t, AAC_SEQUENCE_HEADER)); }
        fragments.push(transmuxer.feed(video(t, keyframes(t))));
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
  // FFmpeg は、配信を始める時にまだ初期化情報がないと、中身が空の初期化情報を先に送り、最初のフレームの直前に本当の初期化情報を送り直す
  test.each([
    ['AAC (FFmpeg -c copy from ADTS AAC)', AVC_SEQUENCE_HEADER, Buffer.from('af00', 'hex')],
    ['AVC (FFmpeg with an encoder that does not output a global header)', Buffer.from('1700000000', 'hex'), AAC_SEQUENCE_HEADER],
  ])('%s: the empty sequence header is ignored until the real one arrives', (_, videoHeader, audioHeader) => {
    const transmuxer = new FMP4Transmuxer();
    transmuxer.feed(metadata(7, 10));
    transmuxer.feed(video(0, videoHeader));
    transmuxer.feed(audio(0, audioHeader));
    const fragments: (FMP4Fragment | null)[] = [];
    for (let t = 0; t < 3000; t += 100) {
      // 本当の初期化情報は、最初のフレームの直前に届く
      if (t === 0) { transmuxer.feed(video(t, AVC_SEQUENCE_HEADER)); }
      fragments.push(transmuxer.feed(video(t, keyframes(t))));
      if (t === 0) { transmuxer.feed(audio(t + 45, AAC_SEQUENCE_HEADER)); }
      fragments.push(transmuxer.feed(audio(t + 45, AAC_FRAME)));
    }

    expect(tracks(transmuxer)).toStrictEqual(['avc1', 'mp4a']);
    expect(trackIds(fragments.filter((fragment) => fragment != null))).toStrictEqual(new Set([1, 2]));
  });
});

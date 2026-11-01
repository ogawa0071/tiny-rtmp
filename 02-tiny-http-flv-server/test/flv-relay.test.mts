import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import FLVRelay from '../src/flv-relay.mts';

// FFmpeg が送ってくる AVC と AAC (44.1 kHz) の初期化情報 (VideoTagHeader / AudioTagHeader 付き)
const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
// AVC のフレーム (FrameType 1 はキーフレーム、2 はインターフレーム) と、AAC のフレーム
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

// FLV Tag の Data (Tag Header 11 byte と PreviousTagSize 4 byte の間)
const data = (tag: Buffer): Buffer => tag.subarray(11, tag.byteLength - 4);

// yasea は、videocodecid も audiocodecid もない onMetaData を送ってくる
const YASEA_ONMETADATA = { duration: 0, width: 320, height: 240, videodatarate: 0, framerate: 0, audiodatarate: 0, audiosamplerate: 44100, audiosamplesize: 16, stereo: true, filesize: 0 };

describe('FLV Header', () => {
  // 届いた onMetaData と、視聴を始めた視聴者に送る FLV Header の TypeFlags (4: 音声あり, 1: 映像あり)
  test.each([
    ['no onMetaData', [], 0x05],
    ['H.264 and AAC', [{ videocodecid: 7, audiocodecid: 10 }], 0x05],
    ['H.264 and AAC as strings', [{ videocodecid: 'avc1', audiocodecid: 'mp4a' }], 0x05],
    ['H.264 and MP3 (MP3 is not relayed)', [{ videocodecid: 7, audiocodecid: 2 }], 0x01],
    ['H.263 and AAC (H.263 is not relayed)', [{ videocodecid: 2, audiocodecid: 10 }], 0x04],
    ['onMetaData without codec ids (yasea)', [YASEA_ONMETADATA], 0x05],
    ['H.264 and AAC, then an onMetaData with only the title', [{ videocodecid: 7, audiocodecid: 10 }, { title: 'next' }], 0x05],
    ['H.264 and MP3, then an onMetaData with only the title', [{ videocodecid: 7, audiocodecid: 2 }, { title: 'next' }], 0x01],
  ] as [string, AMF0Object[], number][])('%s', (_, objects, flags) => {
    const relay = new FLVRelay();
    for (const object of objects) {
      expect(relay.accept(onmetadata(object))).toMatchObject({ initial: true, keyframe: false });
    }
    const [header] = relay.initials();
    expect(header.subarray(0, 4).toString('latin1')).toBe('FLV\x01');
    expect(header[4]).toBe(flags);
  });
});

describe('Sequence headers without the configuration', () => {
  // FFmpeg は、配信を始める時にまだ初期化情報がないと、中身が空の初期化情報を先に送り、最初のフレームの直前に本当の初期化情報を送り直す
  test('empty AVC / AAC sequence headers are neither relayed nor sent to viewers who start later', () => {
    const relay = new FLVRelay();
    relay.accept(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    expect(relay.accept(video(0, Buffer.from('1700000000', 'hex')))).toBeNull();
    expect(relay.accept(audio(0, Buffer.from('af00', 'hex')))).toBeNull();
    expect(relay.hasVideoConfig()).toBe(false);
    expect(relay.initials()).toHaveLength(2); // FLV Header と onMetaData

    // 本当の初期化情報が届いたら、それを中継して、途中から視聴を始めた視聴者にも最初に送る
    const avcConfig = relay.accept(video(0, AVC_SEQUENCE_HEADER));
    expect(avcConfig).toMatchObject({ initial: true, keyframe: false });
    const aacConfig = relay.accept(audio(0, AAC_SEQUENCE_HEADER));
    expect(aacConfig).toMatchObject({ initial: true, keyframe: false });
    expect(relay.hasVideoConfig()).toBe(true);
    const [, , avcInitial, aacInitial] = relay.initials();
    expect(data(avcInitial).equals(AVC_SEQUENCE_HEADER)).toBe(true);
    expect(data(aacInitial).equals(AAC_SEQUENCE_HEADER)).toBe(true);

    // フレームは初期化情報ではなく、キーフレームから視聴を始められる
    expect(relay.accept(video(0, avc(1)))).toMatchObject({ initial: false, keyframe: true });
    expect(relay.accept(video(33, avc(2)))).toMatchObject({ initial: false, keyframe: false });
    expect(relay.accept(audio(23, AAC_FRAME))).toMatchObject({ initial: false, keyframe: false });
  });
});

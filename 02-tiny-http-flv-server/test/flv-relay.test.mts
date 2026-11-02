import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import read_amf0 from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import type { AMF0Object, AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import FLVRelay from '../src/flv-relay.mts';

const AVC_SEQUENCE_HEADER = Buffer.from('1700000000014d400dffe10018674d400deca0a0fd8088000003000800000301e078a14cb001000468ce0fc8', 'hex');
const AAC_SEQUENCE_HEADER = Buffer.from('af00120856e500', 'hex');
const avc = (frameType: number): Buffer => Buffer.from([(frameType << 4) | 7, 1, 0, 0, 0, 0, 0, 0, 1, 0x65]);
const AAC_FRAME = Buffer.from('af0121', 'hex');

const onmetadata = (object: AMF0Object): Message => ({
  message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', object],
});
const video = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data });
const audio = (timestamp: number, data: Buffer): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data });

const data = (tag: Buffer): Buffer => tag.subarray(11, tag.byteLength - 4);

const YASEA_ONMETADATA = { duration: 0, width: 320, height: 240, videodatarate: 0, framerate: 0, audiodatarate: 0, audiosamplerate: 44100, audiosamplesize: 16, stereo: true, filesize: 0 };

describe('FLV Header', () => {
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
  test('empty AVC / AAC sequence headers are neither relayed nor sent to viewers who start later', () => {
    const relay = new FLVRelay();
    relay.accept(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    expect(relay.accept(video(0, Buffer.from('1700000000', 'hex')))).toBeNull();
    expect(relay.accept(audio(0, Buffer.from('af00', 'hex')))).toBeNull();
    expect(relay.hasVideoConfig()).toBe(false);
    expect(relay.initials()).toHaveLength(2);

    const avcConfig = relay.accept(video(0, AVC_SEQUENCE_HEADER));
    expect(avcConfig).toMatchObject({ initial: true, keyframe: false });
    const aacConfig = relay.accept(audio(0, AAC_SEQUENCE_HEADER));
    expect(aacConfig).toMatchObject({ initial: true, keyframe: false });
    expect(relay.hasVideoConfig()).toBe(true);
    const [, , avcInitial, aacInitial] = relay.initials();
    expect(data(avcInitial).equals(AVC_SEQUENCE_HEADER)).toBe(true);
    expect(data(aacInitial).equals(AAC_SEQUENCE_HEADER)).toBe(true);

    expect(relay.accept(video(0, avc(1)))).toMatchObject({ initial: false, keyframe: true });
    expect(relay.accept(video(33, avc(2)))).toMatchObject({ initial: false, keyframe: false });
    expect(relay.accept(audio(23, AAC_FRAME))).toMatchObject({ initial: false, keyframe: false });
  });
});

describe('Messages that are not relayed', () => {
  const data_message = (values: AMF0Value[]): Message => ({ message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: values });

  test.each([
    ['MP3 (SoundFormat 2)', audio(0, Buffer.from('2fff', 'hex'))],
    ['Enhanced RTMP audio (SoundFormat 9, MultichannelConfig)', audio(0, Buffer.from('946d70346101060000003f', 'hex'))],
    ['Enhanced RTMP video (HEVC)', video(0, Buffer.from('91687663310000000000', 'hex'))],
    ['Sorenson H.263 (CodecID 2)', video(0, Buffer.from('22000084001f0000', 'hex'))],
    ['a video info / command frame (FrameType 5)', video(0, Buffer.from('5701', 'hex'))],
    ['an Enhanced RTMP video packet whose PacketType is 7', video(0, Buffer.from('97617663310000000000', 'hex'))],
    ['a video message that is too short', video(0, Buffer.from('17', 'hex'))],
    ['an audio message that is too short', audio(0, Buffer.from('af', 'hex'))],
    ['a video message with the reserved FrameType 0', video(0, Buffer.from('0701000000', 'hex'))],
    ['onTextData', data_message(['@setDataFrame', 'onTextData', { text: 'hello' }])],
    ['onMetaData that is not an object', data_message(['@setDataFrame', 'onMetaData', 'hello'])],
  ])('%s is not relayed', (_, message) => {
    const relay = new FLVRelay();
    expect(relay.accept(message)).toBeNull();
    expect(relay.initials()).toHaveLength(1);
  });

  test.each<[string, AMF0Value[]]>([
    ['with @setDataFrame', ['@setDataFrame', 'onMetaData', { videocodecid: 7, audiocodecid: 10 }]],
    ['without @setDataFrame', ['onMetaData', { videocodecid: 7, audiocodecid: 10 }]],
  ])('onMetaData %s is relayed without @setDataFrame', (_, values) => {
    const relay = new FLVRelay();
    const relayed = relay.accept(data_message(values));
    expect(relayed).not.toBeNull();
    expect(read_amf0(data(relayed!.tag))).toEqual(['onMetaData', { videocodecid: 7, audiocodecid: 10 }]);
  });

  test('viewers who start later get the latest onMetaData and sequence headers, not an end of sequence', () => {
    const relay = new FLVRelay();
    relay.accept(onmetadata({ videocodecid: 7, audiocodecid: 10 }));
    relay.accept(video(0, AVC_SEQUENCE_HEADER));
    relay.accept(audio(0, AAC_SEQUENCE_HEADER));
    relay.accept(onmetadata({ videocodecid: 7, audiocodecid: 10, title: 'next' }));
    const avc2 = Buffer.from(AVC_SEQUENCE_HEADER);
    avc2[8] = 0x1e;
    const aac2 = Buffer.from('af00121056e500', 'hex');
    relay.accept(video(1000, avc2));
    relay.accept(audio(1000, aac2));
    expect(relay.accept(video(2000, Buffer.from('1702000000', 'hex')))).toMatchObject({ initial: false, keyframe: false });

    const [, meta, avcInitial, aacInitial] = relay.initials();
    expect(read_amf0(data(meta))).toEqual(['onMetaData', { videocodecid: 7, audiocodecid: 10, title: 'next' }]);
    expect(data(avcInitial).equals(avc2)).toBe(true);
    expect(data(aacInitial).equals(aac2)).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';

import { handle_audio, handle_video, read_onmetadata } from '../src/rtmp-handler.mts';

describe('FLV Tag', () => {
  test.each([
    ['empty video', ''],
    ['too short AVC', '1701'],
    ['video command frame (FrameType: 5)', '5700'],
    ['Enhanced RTMP ExVideoTagHeader', '9068766331'],
    // 長さの確認では弾かれず、CodecID (下位 4bit) は 7 (AVC) に見える入力で、FrameType 5 と ExVideoTagHeader の判定を確かめる
    ['video command frame (FrameType: 5) with AVC CodecID', '5700000000'],
    ['Enhanced RTMP ExVideoTagHeader with PacketType 7 (looks like AVC CodecID)', '9700000000ff'],
  ])('%s is ignored', (_, hex) => {
    expect(handle_video({ timestamp: 0, data: Buffer.from(hex, 'hex') })).toBeNull();
  });

  test('AVC NALU', () => {
    // FrameType: 1 (key frame), CodecID: 7 (AVC), AVCPacketType: 1 (NALU), CompositionTime: -33
    expect(handle_video({ timestamp: 100, data: Buffer.from('1701ffffdfaa', 'hex') })).toStrictEqual({
      kind: 'Video',
      codec: 'AVC',
      frameType: 1,
      timestamp: 100,
      packetType: 1,
      compositionTimeOffset: -33,
      data: Buffer.from('aa', 'hex'),
    });
  });

  test.each([
    ['empty audio', ''],
    ['too short AAC', 'af'],
  ])('%s is ignored', (_, hex) => {
    expect(handle_audio({ timestamp: 0, data: Buffer.from(hex, 'hex') })).toBeNull();
  });
});

describe('onMetaData', () => {
  test('with @setDataFrame', () => {
    expect(read_onmetadata(['@setDataFrame', 'onMetaData', { width: 320 }])).toStrictEqual({ width: 320 });
  });

  test('without @setDataFrame', () => {
    expect(read_onmetadata(['onMetaData', { width: 320 }])).toStrictEqual({ width: 320 });
  });

  test('other data', () => {
    expect(read_onmetadata(['onTextData', { text: 'hello' }])).toBeNull();
  });
});

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
    // FFmpeg は、エンコーダが初期化情報を出さない時、中身が空の初期化情報を先に送ってくる
    ['AVC sequence header without AVCDecoderConfigurationRecord', '1700000000'],
  ])('%s is ignored', (_, hex) => {
    expect(handle_video({ timestamp: 0, data: Buffer.from(hex, 'hex') })).toBeNull();
  });

  test('AVC sequence header', () => {
    // FrameType: 1 (key frame), CodecID: 7 (AVC), AVCPacketType: 0 (sequence header), CompositionTime: 0
    expect(handle_video({ timestamp: 21, data: Buffer.from('170000000001640016', 'hex') })).toStrictEqual({
      kind: 'Video',
      codec: 'AVC',
      frameType: 1,
      timestamp: 21,
      packetType: 0,
      avcDecoderConfigurationRecord: Buffer.from('01640016', 'hex'),
    });
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
    // FFmpeg は、ADTS の AAC (MPEG-TS などの入力) を -c copy で送る時、中身が空の初期化情報を先に送ってくる
    ['AAC sequence header without AudioSpecificConfig', 'af00'],
  ])('%s is ignored', (_, hex) => {
    expect(handle_audio({ timestamp: 0, data: Buffer.from(hex, 'hex') })).toBeNull();
  });

  test('AAC sequence header', () => {
    // SoundFormat: 10 (AAC), AACPacketType: 0 (sequence header), AudioSpecificConfig: AAC-LC, 48 kHz, 2ch
    expect(handle_audio({ timestamp: 45, data: Buffer.from('af001190', 'hex') })).toStrictEqual({
      kind: 'Audio',
      codec: 'AAC',
      timestamp: 45,
      packetType: 0,
      audioSpecificConfig: Buffer.from('1190', 'hex'),
    });
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

import { describe, expect, test } from 'vitest';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';

import { handle_audio, handle_video, read_onmetadata, TimestampUnwrapper } from '../src/rtmp-handler.mts';

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

describe('TimestampUnwrapper', () => {
  const video = (timestamp: number): Message => ({ message_type_id: MessageType.Video, message_stream_id: 1, timestamp, data: Buffer.alloc(0) });
  const audio = (timestamp: number): Message => ({ message_type_id: MessageType.Audio, message_stream_id: 1, timestamp, data: Buffer.alloc(0) });
  const unwrap = (messages: Message[]): number[] => {
    const unwrapper = new TimestampUnwrapper();
    return messages.map((message) => unwrapper.unwrap(message).timestamp);
  };

  test('timestamps that do not wrap around are left as they are', () => {
    expect(unwrap([video(1000), audio(1021), video(1033), audio(990), video(1067)])).toStrictEqual([1000, 1021, 1033, 990, 1067]);
  });

  test('an onMetaData is left as it is and does not move the time of the video and audio', () => {
    const unwrapper = new TimestampUnwrapper();
    unwrapper.unwrap(video(2 ** 32 - 33));
    const onmetadata: Message = { message_type_id: MessageType.DataAMF0, message_stream_id: 1, timestamp: 0, data: ['@setDataFrame', 'onMetaData', {}] };
    expect(unwrapper.unwrap(onmetadata)).toStrictEqual(onmetadata);
    expect(unwrapper.unwrap(video(0)).timestamp).toBe(2 ** 32);
  });

  test.each([
    // RTMP 仕様の 32bit (約 49.7 日) と、FFmpeg の 31bit (約 24.8 日)
    ['32bit wraparound of the RTMP specification', 2 ** 32],
    ['31bit wraparound of FFmpeg', 2 ** 31],
  ])('%s keeps the time increasing', (_, wrap) => {
    expect(unwrap([video(wrap - 33), audio(wrap - 11), video(0), audio(12), video(33)])).toStrictEqual([wrap - 33, wrap - 11, wrap, wrap + 12, wrap + 33]);
  });

  test('negative DTS of FFmpeg (-avoid_negative_ts disabled, sent as 0x7FFFFFxx) are shifted so that the time is not negative', () => {
    // FFmpeg は初期化情報を 0 ms で送ってから、-67 ms のキーフレーム, -33 ms の映像, -21 ms の音声, 0 ms の映像と音声を 31bit で送る
    expect(unwrap([video(0), audio(0), video(0x7FFFFFBD), video(0x7FFFFFDF), audio(0x7FFFFFEB), video(0), audio(0)])).toStrictEqual([0, 0, 0, 34, 46, 67, 67]);
  });

  test('only the negative timestamps in the first second of the stream move the time of the video and audio', () => {
    // 0.5 秒 (配信の最初の 1 秒の間) に届いた -40 ms の音声では全体を 40 ms ずらし、1.5 秒に届いた -96 ms の音声ではずらさない (0 にする)
    expect(unwrap([video(0), video(500), audio(0x7FFFFFD8), video(533), video(1500), audio(0x7FFFFFA0), video(1533)])).toStrictEqual([0, 500, 0, 573, 1540, 0, 1573]);
  });

  test('a negative timestamp that arrives later becomes 0 and does not move the time of the video and audio after it', () => {
    // 配信の途中 (5 秒) で -96 ms の音声が 1 つだけ届いても、ずらす量は最初に決めた 67 ms のままにする
    expect(unwrap([video(0), audio(0), video(0x7FFFFFBD), video(0), audio(5000), audio(0xFFFFFFA0), video(5033), audio(5023)])).toStrictEqual([0, 0, 0, 67, 5067, 0, 5100, 5090]);
  });
});

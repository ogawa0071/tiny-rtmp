import { describe, expect, test } from 'vitest';

import AsyncByteReader from '../src/async-byte-reader.mts';
import read_message from '../src/message-reader.mts';
import { isAMF0Array, isAMF0Object, type AMF0Value } from '../src/amf0-reader.mts';

const strip = (value: AMF0Value): AMF0Value => {
  if (isAMF0Array(value)) {
    return value.map((elem) => strip(elem));
  } else if (isAMF0Object(value)) {
    const obj = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      obj[k] = strip(v);
    }
    return obj;
  } else {
    return value;
  }
};

describe('Regression Test', () => {
  test('Messaging (FFmpeg)', async () => {
    const reader = new AsyncByteReader();
    const gen = read_message(reader)[Symbol.asyncIterator]();

    // connect
    reader.feed(Buffer.from('03000000000088140000000002000763', 'hex'));
    reader.feed(Buffer.from('6f6e6e656374003ff000000000000003', 'hex'));
    reader.feed(Buffer.from('00036170700200036170700004747970', 'hex'));
    reader.feed(Buffer.from('6502000a6e6f6e707269766174650008', 'hex'));
    reader.feed(Buffer.from('666c617368566572020023464d4c452f', 'hex'));
    reader.feed(Buffer.from('332e302028636f6d70617469626c653b', 'hex'));
    reader.feed(Buffer.from('204c61766636312e372e313030290005', 'hex'));
    reader.feed(Buffer.from('746355726c02001972746d703a2f2f6c', 'hex'));
    reader.feed(Buffer.from('6f63616c686f73743a313933c3352f61', 'hex'));
    reader.feed(Buffer.from('7070000009', 'hex'));

    // releaseStream
    reader.feed(Buffer.from('4300000000002014', 'hex'));
    reader.feed(Buffer.from('02000d72656c6561736553747265616d', 'hex'));
    reader.feed(Buffer.from('004000000000000000050200036b6579', 'hex'));

    // FCPublish
    reader.feed(Buffer.from('4300000000001c140200094643507562', 'hex'));
    reader.feed(Buffer.from('6c697368004008000000000000050200', 'hex'));
    reader.feed(Buffer.from('036b6579', 'hex'));

    // createStream
    reader.feed(Buffer.from('430000000000191402000c63', 'hex'));
    reader.feed(Buffer.from('726561746553747265616d0040100000', 'hex'));
    reader.feed(Buffer.from('0000000005', 'hex'));

    // publish
    reader.feed(Buffer.from('080000000000211401000000', 'hex'));
    reader.feed(Buffer.from('0200077075626c697368004014000000', 'hex'));
    reader.feed(Buffer.from('000000050200036b65790200046c6976', 'hex'));
    reader.feed(Buffer.from('65', 'hex'));

    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'connect',
        1,
        {
          app: 'app',
          flashVer: 'FMLE/3.0 (compatible; Lavf61.7.100)',
          tcUrl: 'rtmp://localhost:1935/app',
          type: 'nonprivate',
        },
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'releaseStream',
        2,
        null,
        'key',
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'FCPublish',
        3,
        null,
        'key',
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'createStream',
        4,
        null,
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(1);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'publish',
        5,
        null,
        'key',
        'live',
      ]));
    }
  });

  test('Messaging (OBS)', async () => {
    const reader = new AsyncByteReader();
    const gen = read_message(reader)[Symbol.asyncIterator]();

    // SetChunkSize
    reader.feed(Buffer.from('02000000000004010000000000001000', 'hex'));

    // connect
    reader.feed(Buffer.from('030000000000a8140000000002000763', 'hex'));
    reader.feed(Buffer.from('6f6e6e656374003ff000000000000003', 'hex'));
    reader.feed(Buffer.from('00036170700200036170700004747970', 'hex'));
    reader.feed(Buffer.from('6502000a6e6f6e707269766174650008', 'hex'));
    reader.feed(Buffer.from('666c61736856657202001f464d4c452f', 'hex'));
    reader.feed(Buffer.from('332e302028636f6d70617469626c653b', 'hex'));
    reader.feed(Buffer.from('20464d53632f312e3029000673776655', 'hex'));
    reader.feed(Buffer.from('726c02001972746d703a2f2f6c6f6361', 'hex'));
    reader.feed(Buffer.from('6c686f73743a313933352f6170700005', 'hex'));
    reader.feed(Buffer.from('746355726c02001972746d703a2f2f6c', 'hex'));
    reader.feed(Buffer.from('6f63616c686f73743a313933352f6170', 'hex'));
    reader.feed(Buffer.from('70000009', 'hex'));

    // releaseStream
    reader.feed(Buffer.from('430000000000201402000d72656c6561', 'hex'));
    reader.feed(Buffer.from('736553747265616d0040000000000000', 'hex'));
    reader.feed(Buffer.from('00050200036b6579', 'hex'));

    // FCPublish
    reader.feed(Buffer.from('4300000000001c140200094643507562', 'hex'));
    reader.feed(Buffer.from('6c697368004008000000000000050200', 'hex'));

    // createStream
    reader.feed(Buffer.from('036b6579430000000000191402000c63', 'hex'));
    reader.feed(Buffer.from('726561746553747265616d0040100000', 'hex'));
    reader.feed(Buffer.from('0000000005', 'hex'));

    // publish
    reader.feed(Buffer.from('04000000000021140100000002000770', 'hex'));
    reader.feed(Buffer.from('75626c69736800401400000000000005', 'hex'));
    reader.feed(Buffer.from('0200036b65790200046c697665', 'hex'));

    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'connect',
        1,
        {
          app: 'app',
          flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
          swfUrl: 'rtmp://localhost:1935/app',
          tcUrl: 'rtmp://localhost:1935/app',
          type: 'nonprivate',
        },
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'releaseStream',
        2,
        null,
        'key',
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'FCPublish',
        3,
        null,
        'key',
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(0);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'createStream',
        4,
        null,
      ]));
    }
    {
      const message = (await gen.next()).value;
      expect(message.message_type_id).toStrictEqual(20);
      expect(message.message_stream_id).toStrictEqual(1);
      expect(message.timestamp).toStrictEqual(0);
      expect(message.data).toStrictEqual(strip([
        'publish',
        5,
        null,
        'key',
        'live',
      ]));
    }
  });
});

describe('Chunk Header', () => {
  test('Timestamp delta wraps around at 2^32', async () => {
    const reader = new AsyncByteReader();
    const gen = read_message(reader)[Symbol.asyncIterator]();

    reader.feed(Buffer.from('04ffffff00000108' + '01000000' + 'fffffff0' + 'aa', 'hex'));
    reader.feed(Buffer.from('4400002000000108' + 'bb', 'hex'));
    reader.feed(Buffer.from('c4' + 'cc', 'hex'));

    expect((await gen.next()).value).toMatchObject({ timestamp: 0xFFFFFFF0, data: Buffer.from('aa', 'hex') });
    expect((await gen.next()).value).toMatchObject({ timestamp: 0x10, data: Buffer.from('bb', 'hex') });
    expect((await gen.next()).value).toMatchObject({ timestamp: 0x30, data: Buffer.from('cc', 'hex') });
  });

  test('Abort discards only the partial message, not the header state', async () => {
    const reader = new AsyncByteReader();
    const gen = read_message(reader)[Symbol.asyncIterator]();

    reader.feed(Buffer.from('060000640000c809' + '01000000', 'hex'));
    reader.feed(Buffer.alloc(128));
    reader.feed(Buffer.from('020000000000040200000000' + '00000006', 'hex'));
    reader.feed(Buffer.concat([Buffer.from('c6', 'hex'), Buffer.alloc(128, 0x11)]));
    reader.feed(Buffer.concat([Buffer.from('c6', 'hex'), Buffer.alloc(72, 0x11)]));
    reader.feed(Buffer.from('4600002100000209' + '1701', 'hex'));

    expect((await gen.next()).value).toMatchObject({
      message_type_id: 9,
      message_stream_id: 1,
      timestamp: 200,
      data: Buffer.alloc(200, 0x11),
    });
    expect((await gen.next()).value).toMatchObject({
      message_type_id: 9,
      message_stream_id: 1,
      timestamp: 233,
      data: Buffer.from('1701', 'hex'),
    });
  });
});

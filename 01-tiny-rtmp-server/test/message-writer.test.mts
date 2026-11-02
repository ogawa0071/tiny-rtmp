import { describe, expect, test } from 'vitest';

import AsyncByteReader from '../src/async-byte-reader.mts';
import read_message from '../src/message-reader.mts';
import { MessageType, SetChunkSize, type Message } from '../src/message.mts';
import MessageWriter from '../src/message-writer.mts';

const media = (message_type_id: typeof MessageType.Audio | typeof MessageType.Video, timestamp: number, length: number): Message => {
  return {
    message_type_id,
    message_stream_id: 1,
    timestamp,
    data: Buffer.from(Array.from({ length }, (_, i) => i % 256)),
  };
};

const collect = async (reader: AsyncByteReader): Promise<Message[]> => {
  const messages: Message[] = [];
  try {
    for await (const message of read_message(reader)) { messages.push(message); }
  } catch {
  }
  return messages;
};

describe('Unit Test', () => {
  test('Write messages and read them back', async () => {
    using writer = new MessageWriter();
    const reader = new AsyncByteReader();
    const expected = [
      media(MessageType.Video, 0, 300),
      media(MessageType.Audio, 10, 10),
      media(MessageType.Video, 33, 10),
    ];

    for (const message of expected) { writer.write(message); }
    writer.end();
    for await (const chunk of writer.retrieve()) { reader.feed(chunk); }
    reader.feedEOF();

    await expect(writer.ended()).resolves.toBeUndefined();
    const received = await collect(reader);
    expect(received.filter((message) => message.message_type_id === MessageType.Video)).toStrictEqual([expected[0], expected[2]]);
    expect(received.filter((message) => message.message_type_id === MessageType.Audio)).toStrictEqual([expected[1]]);
  });

  test('Apply SetChunkSize to the following chunks', async () => {
    using writer = new MessageWriter();
    const reader = new AsyncByteReader();
    const video = media(MessageType.Video, 0, 4096);

    writer.write(SetChunkSize.from({ chunk_size: 4096, timestamp: 0 }));
    writer.write(video);
    writer.end();
    const chunks = [];
    for await (const chunk of writer.retrieve()) { chunks.push(chunk); reader.feed(chunk); }
    reader.feedEOF();

    expect(chunks.length).toStrictEqual(2);
    expect(await collect(reader)).toStrictEqual([video]);
  });
});

describe('Regression Test', () => {
  test('Messages written while retrieve() is suspended are not lost', async () => {
    using writer = new MessageWriter();
    const reader = new AsyncByteReader();
    const iterator = writer.retrieve()[Symbol.asyncIterator]();

    writer.write(media(MessageType.Video, 0, 10));
    writer.write(media(MessageType.Audio, 0, 10));
    reader.feed((await iterator.next()).value);
    reader.feed((await iterator.next()).value);
    writer.write(media(MessageType.Audio, 20, 300));
    reader.feed((await iterator.next()).value);
    writer.write(media(MessageType.Video, 20, 10));
    writer.end();
    for (let result = await iterator.next(); !result.done; result = await iterator.next()) {
      reader.feed(result.value);
    }
    reader.feedEOF();

    const videos = (await collect(reader)).filter((message) => message.message_type_id === MessageType.Video);
    expect(videos.map(({ timestamp }) => timestamp)).toStrictEqual([0, 20]);
  });
});

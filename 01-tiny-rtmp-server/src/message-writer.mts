import ByteBuilder from './byte-builder.mts';
import { Message, MessageType } from './message.mts';
import Queue from './queue.mts';

export type MessageWithTrack = Message & {
  track?: number;
};
export const MessageWithTrack = {
  from(message: Message, track?: number): MessageWithTrack {
    return {
      ... message,
      track,
    };
  },
};

type SendingMessage = Message & {
  chunk_stream_id: number;
  binary: Buffer;
  offset: number;
};

export type MessageWriterOption = Partial<{
  signal: AbortSignal;
  highWaterMark: number;
}>;

const is_system_message = ({ message_type_id }: Message): boolean => {
  // Protocol Control Message と User Control Message は cs_id は必ず 2 を使う
  switch (message_type_id) {
    // Protocol Control Message
    case MessageType.SetChunkSize:
    case MessageType.Abort:
    case MessageType.Acknowledgement:
    case MessageType.WindowAcknowledgementSize:
    case MessageType.SetPeerBandwidth:
    // User Control Message
    case MessageType.UserControl:
      return true;
    default:
      return false;
  }
};

const is_input_order_sensitive = (message: Message): boolean => {
  // 映像・音声データの伝送を確立するためのメッセージは順序を維持するようにする
  if (is_system_message(message)) { return true; }
  switch (message.message_type_id) {
    // Command AMF
    case MessageType.CommandAMF0:
    case MessageType.CommandAMF3:
      return true;
    default:
      return false;
  }
};

const write_basic_header = (builder: ByteBuilder, fmt: number, cs_id: number): void => {
  if (cs_id >= 320) {
    builder.writeU8((fmt << 6) | 1);
    builder.writeU16LE(cs_id - 64);
  } else if (cs_id >= 64) {
    builder.writeU8((fmt << 6) | 0);
    builder.writeU8(cs_id - 64);
  } else {
    builder.writeU8((fmt << 6) | cs_id);
  }
};

export default class MessageWriter {
  private highWaterMark: number;
  private chunk_maximum_size = 128;
  private next_cs_id = 3;
  private cs_id_map = new Map<string, number>();
  private previous_timestamps = new Map<number, number>();

  private controller = new AbortController();
  private signal: AbortSignal;
  private wakeup = Promise.withResolvers<void>();
  private sending_ordering_queue = new Queue<SendingMessage>();
  private sending_cs_id_queues = new Map<number, Queue<SendingMessage>>();
  private sending_bytes = 0;

  private ended_boolean = false;
  private ended_resolvers = Promise.withResolvers<void>();

  public constructor(option?: MessageWriterOption) {
    this.highWaterMark = option?.highWaterMark ?? Number.POSITIVE_INFINITY;
    this.signal = AbortSignal.any([this.controller.signal, option?.signal].filter((signal) => signal != null));
    if (this.signal.aborted) {
      this.terminate();
    } else {
      this.signal.addEventListener('abort', () => { this.terminate(); }, { once: true });
    }
  }

  private terminate(): void {
    this.ended_boolean = true;
    this.ended_resolvers.resolve();
    this.notify();
  }

  private notify(): void {
    this.wakeup.resolve();
  }

  private async wait(): Promise<void> {
    await this.wakeup.promise;
    this.wakeup = Promise.withResolvers<void>();
  }

  private get_cs_id(message: MessageWithTrack): number {
    if (is_system_message(message)) { return 2; }

    const key = `${message.message_stream_id}/${message.message_type_id}/${message.track ?? 0}`;
    return this.cs_id_map.getOrInsertComputed(key, () => this.next_cs_id++);
  }

  private build_chunk(message: SendingMessage, length: number): Buffer {
    const previous = this.previous_timestamps.get(message.chunk_stream_id);
    const is_absolute = previous == null || message.timestamp < previous;
    const timestamp = is_absolute ? message.timestamp : message.timestamp - previous;
    const is_extended_timestamp = timestamp >= 0xFFFFFF;
    const fmt = message.offset > 0 ? 3 : is_absolute ? 0 : 1;

    const builder = new ByteBuilder();
    write_basic_header(builder, fmt, message.chunk_stream_id);
    if (fmt === 0 || fmt === 1) {
      builder.writeU24BE(is_extended_timestamp ? 0xFFFFFF : timestamp);
      builder.writeU24BE(message.binary.byteLength);
      builder.writeU8(message.message_type_id);
    }
    if (fmt === 0) {
      builder.writeU32LE(message.message_stream_id);
    }
    if (is_extended_timestamp) {
      builder.writeU32BE(timestamp % (2 ** 32));
    }
    builder.write(message.binary.subarray(message.offset, message.offset + length));
    return builder.build();
  }

  private complete(message: SendingMessage): void {
    if (message.message_type_id === MessageType.SetChunkSize) {
      this.chunk_maximum_size = message.data.chunk_size;
    }

    if (message.message_type_id === MessageType.Abort) {
      this.previous_timestamps.delete(message.data.chunk_stream_id);
    } else {
      this.previous_timestamps.set(message.chunk_stream_id, message.timestamp);
    }
  }

  public async *retrieve(): AsyncIterable<Buffer> {
    while (!this.signal.aborted) {
      if (this.sending_cs_id_queues.size === 0) {
        // 終了要求が来ていて、追加がない状態で全部なくなったら終了
        if (this.ended_boolean) { break; }
        await this.wait();
        continue;
      }

      for (const [cs_id, queue] of this.sending_cs_id_queues) {
        const message = queue.peek()!;
        const length = Math.min(message.binary.byteLength - message.offset, this.chunk_maximum_size);
        const is_last_chunk = message.offset + length >= message.binary.byteLength;
        // 投入順に完成するように、投入順とは違う完成は防ぐ
        if (is_last_chunk && is_input_order_sensitive(message) && this.sending_ordering_queue.peek() !== message) {
          continue;
        }

        yield this.build_chunk(message, length);
        this.sending_bytes -= length;
        message.offset += length;

        if (!is_last_chunk) { continue; }
        queue.pop();
        if (is_input_order_sensitive(message)) {
          this.sending_ordering_queue.pop();
        }
        this.complete(message);
        if (queue.empty()) {
          this.sending_cs_id_queues.delete(cs_id);
        }
      }
    }

    this.ended_resolvers.resolve();
  }

  public write(message: MessageWithTrack): void {
    if (this.highWaterMark < this.sending_bytes) {
      this.abort(new Error('Buffer overflow: highWaterMark exceeded'));
    }
    if (this.signal.aborted) {
      throw this.signal.reason;
    } else if (this.ended_boolean) {
      throw new Error('Cannot write to MessageWriter after end');
    }

    const cs_id = this.get_cs_id(message);
    const sending = {
      ... message,
      binary: Message.into(message).data,
      chunk_stream_id: cs_id,
      offset: 0,
    } satisfies SendingMessage;

    const queue = this.sending_cs_id_queues.getOrInsertComputed(cs_id, () => new Queue<SendingMessage>());
    queue.push(sending);
    if (is_input_order_sensitive(sending)) {
      this.sending_ordering_queue.push(sending);
    }
    this.sending_bytes += sending.binary.byteLength;
    this.notify();
  }

  public end(): void {
    this.ended_boolean = true;
    this.notify();
  }

  public [Symbol.dispose](): void {
    this.end();
  }

  public ended(): Promise<void> {
    return this.ended_resolvers.promise;
  }

  public abort(reason?: unknown): void {
    this.controller.abort(reason);
  }
}

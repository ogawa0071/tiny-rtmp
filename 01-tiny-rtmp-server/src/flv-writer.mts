import type { Writable } from 'node:stream';
import ByteBuilder from './byte-builder.mts';
import { MessageType } from './message.mts';
import type { SerializedMessage } from './message.mts';
import read_amf0, { isAMF0Object } from './amf0-reader.mts';
import type { AMF0Object } from './amf0-reader.mts';

// FLV Header
export const write_flv_header = (has_audio: boolean, has_video: boolean): Buffer => {
  return Buffer.from([
    0x46, 0x4C, 0x56, // Signature (FLV)
    1, // version
    (has_audio ? 4 : 0) | (has_video ? 1 : 0),
    0, 0, 0, 9, // Header Bytes
    0, 0, 0, 0, // PreviousTagSize0
  ]);
};

export const write_flv_tag = ({ message_type_id, timestamp, data }: SerializedMessage): Buffer => {
  const builder = new ByteBuilder();
  builder.writeU8(message_type_id);
  builder.writeU24BE(data.byteLength);
  builder.writeU24BE(timestamp % 2 ** 24);
  builder.writeU8(Math.floor(timestamp / 2 ** 24) % 2 ** 8);
  builder.writeU24BE(0);
  builder.write(data);
  builder.writeU32BE(11 + data.byteLength);
  return builder.build();
};

const is_valid_flv_tag = (message: SerializedMessage): boolean => {
  switch (message.message_type_id) {
    case MessageType.Audio:
    case MessageType.Video:
    case MessageType.DataAMF0:
      return true;
    default:
      return false;
  }
};

export default class FLVWriter {
  private output: Writable;
  private initialized: boolean = false;

  public constructor(output: Writable) {
    this.output = output;
  }

  private write_header(onMetaData?: AMF0Object): void {
    const declared = onMetaData?.audiocodecid != null || onMetaData?.videocodecid != null;
    const has_audio = !declared || onMetaData?.audiocodecid != null;
    const has_video = !declared || onMetaData?.videocodecid != null;
    this.output.write(write_flv_header(has_audio, has_video));
    this.initialized = true;
  }

  public write(message: SerializedMessage): void {
    if (!is_valid_flv_tag(message)) { return; }
    if (!this.initialized) {
      const scriptdata = message.message_type_id === MessageType.DataAMF0 ? read_amf0(message.data) : undefined;
      const [name, metadata] = scriptdata ?? [];
      this.write_header(scriptdata?.length === 2 && name === 'onMetaData' && isAMF0Object(metadata) ? metadata : undefined);
    }

    this.output.write(write_flv_tag(message));
  }

  public close(): void {
    // 標準出力と標準エラー出力は閉じると他に影響するので閉じない
    if (this.output === process.stdout) { return; }
    if (this.output === process.stderr) { return; }
    this.output.end();
  }
  public [Symbol.dispose](): void { this.close(); }
}

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import ByteReader from '../../01-tiny-rtmp-server/src/byte-reader.mts';
import { isAMF0Object, type AMF0Object, type AMF0Value } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

export const VideoCodecType = {
  AVC: 7,
} as const;

export const AudioCodecType = {
  AAC: 10,
} as const;

export const FrameType = {
  KEY_FRAME: 1,
  INTER_FRAME: 2,
  DISPOSABLE_INTER_FRAME: 3,
  GENERATED_KEY_FRAME: 4,
  VIDEO_INFO_OR_COMMAND: 5,
} as const;

export const PacketType = {
  SequenceStart: 0,
  CodedFrames: 1,
  SequenceEnd: 2,
} as const;

export type AVCData = {
  codec: 'AVC';
} & ({
  packetType: typeof PacketType.SequenceStart;
  avcDecoderConfigurationRecord: Buffer;
} | {
  packetType: typeof PacketType.CodedFrames;
  compositionTimeOffset: number;
  data: Buffer;
});
export type VideoData = AVCData & {
  timestamp: number;
  frameType: number;
  kind: 'Video';
};

export const AACPacketType = {
  SequenceHeader: 0,
  Raw: 1,
} as const;
export type AACData = {
  codec: 'AAC';
} & ({
  packetType: typeof AACPacketType.SequenceHeader;
  audioSpecificConfig: Buffer;
} | {
  packetType: typeof AACPacketType.Raw;
  data: Buffer;
});
export type AudioData = AACData & {
  timestamp: number;
  kind: 'Audio';
};

export type ActionScriptData = {
  timestamp: number;
  kind: 'Data';
  values: AMF0Value[];
};

const handle_avc = (reader: ByteReader): AVCData | null => {
  const packetType = reader.readU8();
  const compositionTimeOffset = reader.readI24BE();

  switch (packetType) {
    case PacketType.SequenceStart: {
      const avcDecoderConfigurationRecord = reader.read();
      if (avcDecoderConfigurationRecord.byteLength === 0) { return null; }
      return { codec: 'AVC', packetType, avcDecoderConfigurationRecord };
    }
    case PacketType.CodedFrames: return {
      codec: 'AVC',
      packetType,
      compositionTimeOffset,
      data: reader.read(),
    };
    default:
      return null;
  }
};

export const handle_video = ({ timestamp, data }: { timestamp: number; data: Buffer; }): VideoData | null => {
  if (data.byteLength < 5) { return null; }
  const reader = new ByteReader(data);

  const meta = reader.readU8();
  const frameType = (meta & 0xF0) >> 4;
  const codec = meta & 0x0F;
  if (frameType === FrameType.VIDEO_INFO_OR_COMMAND || (meta & 0x80) !== 0) { return null; }

  switch (codec) {
    case VideoCodecType.AVC: {
      const avc = handle_avc(reader);
      if (avc == null) { return null; }
      return { kind: 'Video', frameType, timestamp, ... avc };
    }
    default:
      return null;
  }
};

const handle_aac = (reader: ByteReader): AACData | null => {
  const packetType = reader.readU8();
  switch (packetType) {
    case AACPacketType.SequenceHeader: {
      const audioSpecificConfig = reader.read();
      if (audioSpecificConfig.byteLength === 0) { return null; }
      return { codec: 'AAC', packetType, audioSpecificConfig };
    }
    case AACPacketType.Raw: return {
      codec: 'AAC',
      packetType,
      data: reader.read(),
    };
    default:
      return null;
  }
};

export const handle_audio = ({ timestamp, data }: { timestamp: number; data: Buffer; }): AudioData | null => {
  if (data.byteLength < 2) { return null; }
  const reader = new ByteReader(data);

  const meta = reader.readU8();
  const codec = (meta & 0xF0) >> 4;

  switch (codec) {
    case AudioCodecType.AAC: {
      // In AAC: rate, size, type are derived in AudioSpecificConfig
      const aac = handle_aac(reader);
      if (aac == null) { return null; }
      return { kind: 'Audio', timestamp, ... aac };
    }
    default:
      return null;
  }
};

export const handle_amf0_data = ({ timestamp, data }: { timestamp: number; data: AMF0Value[]; }): ActionScriptData => {
  return { kind: 'Data', timestamp, values: data };
};

export const read_onmetadata = (values: AMF0Value[]): AMF0Object | null => {
  const [name, metadata] = values[0] === '@setDataFrame' ? values.slice(1) : values;
  if (name !== 'onMetaData' || !isAMF0Object(metadata)) { return null; }
  return metadata;
};

export class TimestampUnwrapper {
  private previous: { received: number; timestamp: number; } | null = null;
  private first: number | null = null;
  private latest: number | null = null;
  private offset = 0;

  public unwrap(message: Message): Message {
    if (message.message_type_id !== MessageType.Audio && message.message_type_id !== MessageType.Video) { return message; }
    let timestamp = message.timestamp;
    if (this.previous != null) {
      const delta = ((message.timestamp - this.previous.received) % 2 ** 31 + 2 ** 31 + 2 ** 30) % 2 ** 31 - 2 ** 30;
      timestamp = this.previous.timestamp + delta;
    }
    this.previous = { received: message.timestamp, timestamp };
    this.first ??= timestamp;
    this.latest = Math.max(this.latest ?? timestamp, timestamp);
    if (this.latest - this.first < 1000) { this.offset = Math.max(this.offset, -timestamp); }
    return { ... message, timestamp: Math.max(0, timestamp + this.offset) };
  }
}

export default (message: Message): VideoData | AudioData | ActionScriptData | null => {
  switch (message.message_type_id) {
    case MessageType.Video: return handle_video(message);
    case MessageType.Audio: return handle_audio(message);
    case MessageType.DataAMF0: return handle_amf0_data(message);
    default: return null;
  }
};

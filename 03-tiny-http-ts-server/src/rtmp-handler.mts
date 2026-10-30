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
    case PacketType.SequenceStart: return {
      codec: 'AVC',
      packetType,
      avcDecoderConfigurationRecord: reader.read(),
    };
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
  const reader = new ByteReader(data);

  const meta = reader.readU8();
  const frameType = (meta & 0xF0) >> 4;
  const codec = meta & 0x0F;

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
    case AACPacketType.SequenceHeader: return {
      codec: 'AAC',
      packetType,
      audioSpecificConfig: reader.read(),
    };
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
  const reader = new ByteReader(data);

  const meta = reader.readU8();
  const codec = (meta & 0xF0) >> 4; // SoundFormat
  // 残りの SoundRate (2bit), SoundSize (1bit), SoundType (1bit) は、AAC では AudioSpecificConfig の値を使う

  switch (codec) {
    case AudioCodecType.AAC: {
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

// 配信ソフトは onMetaData を @setDataFrame 付きで送ってくる (['@setDataFrame', 'onMetaData', { ... }])
export const read_onmetadata = (values: AMF0Value[]): AMF0Object | null => {
  const [command, name, metadata] = values;
  if (command !== '@setDataFrame' || name !== 'onMetaData' || !isAMF0Object(metadata)) { return null; }
  return metadata;
};

export default (message: Message): VideoData | AudioData | ActionScriptData | null => {
  switch (message.message_type_id) {
    case MessageType.Video: return handle_video(message);
    case MessageType.Audio: return handle_audio(message);
    case MessageType.DataAMF0: return handle_amf0_data(message);
    default: return null;
  }
};

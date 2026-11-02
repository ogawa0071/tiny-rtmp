import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import ByteReader from '../../01-tiny-rtmp-server/src/byte-reader.mts';

import { handle_amf0_data, handle_audio as handle_aac_audio, handle_video as handle_legacy_video, AudioCodecType, FrameType, VideoCodecType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import type { AACData, ActionScriptData, AVCData } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

export { FrameType };

export const PacketType = {
  SequenceStart: 0,
  CodedFrames: 1,
  SequenceEnd: 2,
  CodedFramesX: 3, // ertmp で定義された HEVC で cto = 0 の時に cto 省略する PacketType.CodedFrames の亜種
  Metadata: 4,
  MPEG2TSSequenceStart: 5,
  Multitrack: 6,
} as const;

export type HEVCData = {
  codec: 'HEVC';
} & ({
  packetType: typeof PacketType.SequenceStart;
  hevcDecoderConfigurationRecord: Buffer;
} | {
  packetType: typeof PacketType.CodedFrames;
  compositionTimeOffset: number;
  data: Buffer;
});
export type UnsupportedVideoData = {
  codec: 'Unsupported';
  codecId: string | number;
};
export type VideoData = (AVCData | HEVCData | UnsupportedVideoData) & {
  timestamp: number;
  frameType: number;
  kind: 'Video';
};

const handle_hevc = (packetType: number, reader: ByteReader): HEVCData | null => {
  switch (packetType) {
    case PacketType.SequenceStart: {
      const hevcDecoderConfigurationRecord = reader.read();
      if (hevcDecoderConfigurationRecord.byteLength === 0) { return null; }
      return { codec: 'HEVC', packetType, hevcDecoderConfigurationRecord };
    }
    case PacketType.CodedFrames: {
      const compositionTimeOffset = reader.readI24BE();
      return {
        codec: 'HEVC',
        packetType,
        compositionTimeOffset,
        data: reader.read(),
      };
    }
    case PacketType.CodedFramesX: {
      return {
        codec: 'HEVC',
        packetType: PacketType.CodedFrames,
        compositionTimeOffset: 0,
        data: reader.read(),
      };
    }
    default:
      return null;
  }
};

export const handle_video = (message: { timestamp: number; data: Buffer; }): VideoData | null => {
  if (message.data.byteLength < 5) { return null; }
  const reader = new ByteReader(message.data);

  const meta = reader.readU8();
  const isExHeader = (meta & 0x80) !== 0;
  if (!isExHeader) {
    const frameType = (meta & 0xF0) >> 4;
    const codecId = meta & 0x0F;
    if (codecId !== VideoCodecType.AVC && frameType !== FrameType.VIDEO_INFO_OR_COMMAND) {
      return { kind: 'Video', frameType, timestamp: message.timestamp, codec: 'Unsupported', codecId };
    }
    return handle_legacy_video(message);
  }

  const frameType = (meta & 0x70) >> 4;
  const packetType = meta & 0x0F;
  if (frameType === FrameType.VIDEO_INFO_OR_COMMAND) { return null; }
  if (packetType === PacketType.Multitrack) { return null; }
  if (packetType === PacketType.CodedFrames && message.data.byteLength < 8) { return null; }
  const fourcc = reader.read(4).toString('ascii');

  switch (fourcc) {
    case 'hvc1': {
      const hevc = handle_hevc(packetType, reader);
      if (hevc == null) { return null; }
      return { kind: 'Video', frameType, timestamp: message.timestamp, ... hevc };
    }
    default:
      return { kind: 'Video', frameType, timestamp: message.timestamp, codec: 'Unsupported', codecId: fourcc };
  }
};

export type UnsupportedAudioData = {
  codec: 'Unsupported';
  soundFormat: number;
};
export type AudioData = (AACData | UnsupportedAudioData) & {
  timestamp: number;
  kind: 'Audio';
};

export const handle_audio = (message: { timestamp: number; data: Buffer; }): AudioData | null => {
  if (message.data.byteLength < 1) { return null; }
  const soundFormat = (message.data[0] & 0xF0) >> 4;
  if (soundFormat !== AudioCodecType.AAC) {
    return { kind: 'Audio', timestamp: message.timestamp, codec: 'Unsupported', soundFormat };
  }
  return handle_aac_audio(message);
};

export default (message: Message): VideoData | AudioData | ActionScriptData | null => {
  switch (message.message_type_id) {
    case MessageType.Video: return handle_video(message);
    case MessageType.Audio: return handle_audio(message);
    case MessageType.DataAMF0: return handle_amf0_data(message);
    default: return null;
  }
};

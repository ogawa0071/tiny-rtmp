import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import ByteReader from '../../01-tiny-rtmp-server/src/byte-reader.mts';

// 従来の FLV の映像 (AVC) と音声、データの扱いは HTTP-TS 配信 (03-tiny-http-ts-server) と同じものを使う
import { handle_amf0_data, handle_audio, handle_video as handle_legacy_video, FrameType } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';
import type { ActionScriptData, AudioData, AVCData } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

export { FrameType };

export const PacketType = {
  SequenceStart: 0,
  CodedFrames: 1,
  SequenceEnd: 2,
  CodedFramesX: 3, // ertmp で定義された HEVC で cto = 0 の時に cto 省略する PacketType.CodedFrames の亜種
  Metadata: 4,
  MPEG2TSSequenceStart: 5,
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
export type VideoData = (AVCData | HEVCData) & {
  timestamp: number;
  frameType: number;
  kind: 'Video';
};

const handle_hevc = (packetType: number, reader: ByteReader): HEVCData | null => {
  switch (packetType) {
    case PacketType.SequenceStart: return {
      codec: 'HEVC',
      packetType,
      hevcDecoderConfigurationRecord: reader.read(),
    };
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
  // 映像のフレームなら、従来の形式でも Enhanced RTMP の形式でも 5 byte 以上ある
  if (message.data.byteLength < 5) { return null; }
  const reader = new ByteReader(message.data);

  const meta = reader.readU8();
  // 先頭 1bit (IsExHeader) が立っていなければ、従来の FLV の VideoTagHeader
  const isExHeader = (meta & 0x80) !== 0;
  if (!isExHeader) { return handle_legacy_video(message); }

  // Enhanced RTMP の ExVideoTagHeader: IsExHeader (1bit), FrameType (3bit), PacketType (4bit), FourCC (32bit)
  const frameType = (meta & 0x70) >> 4;
  const packetType = meta & 0x0F;
  // FrameType 5 は映像のフレームではなくコマンドなので扱わない
  if (frameType === FrameType.VIDEO_INFO_OR_COMMAND) { return null; }
  // CodedFrames は FourCC の後ろに CompositionTime (SI24) が続く
  if (packetType === PacketType.CodedFrames && message.data.byteLength < 8) { return null; }
  const fourcc = reader.read(4).toString('ascii');

  switch (fourcc) {
    case 'hvc1': {
      const hevc = handle_hevc(packetType, reader);
      if (hevc == null) { return null; }
      return { kind: 'Video', frameType, timestamp: message.timestamp, ... hevc };
    }
    default:
      return null;
  }
};

export default (message: Message): VideoData | AudioData | ActionScriptData | null => {
  switch (message.message_type_id) {
    case MessageType.Video: return handle_video(message);
    case MessageType.Audio: return handle_audio(message);
    case MessageType.DataAMF0: return handle_amf0_data(message);
    default: return null;
  }
};

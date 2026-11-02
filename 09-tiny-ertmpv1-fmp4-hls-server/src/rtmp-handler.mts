import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import ByteReader from '../../01-tiny-rtmp-server/src/byte-reader.mts';

// 従来の FLV の映像 (AVC) と音声 (AAC)、データの扱いは HTTP-TS 配信 (03-tiny-http-ts-server) と同じものを使う
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
  Multitrack: 6, // Enhanced RTMP v2 の Multitrack (FFmpeg 8.0 以降や OBS は、2 つ目以降の映像トラックをこの形式で送る)
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
// 対応していないコーデックの映像 (Enhanced RTMP の AV1 や VP9、従来の形式の Sorenson H.263 や VP6 など)
export type UnsupportedVideoData = {
  codec: 'Unsupported';
  codecId: string | number; // Enhanced RTMP なら FourCC (例: 'av01')、従来の形式なら CodecID (例: 2 は Sorenson H.263)
};
export type VideoData = (AVCData | HEVCData | UnsupportedVideoData) & {
  timestamp: number;
  frameType: number;
  kind: 'Video';
};

const handle_hevc = (packetType: number, reader: ByteReader): HEVCData | null => {
  switch (packetType) {
    case PacketType.SequenceStart: {
      // 中身が空の初期化情報は無視する (FFmpeg はエンコーダが初期化情報を出さない時、空の初期化情報を先に送り、最初のフレームの直前に本当の初期化情報を送り直す)
      // (従来の形式の AVC と AAC も同じ: 03-tiny-http-ts-server の handle_avc)
      // (ただし HEVC の初期化情報を送り直すのは FFmpeg 7.0 以降。FFmpeg 6.1 は送り直さず、フレームも開始コード付き (Annex B) のまま送ってくるので、
      //  その映像は使わない: HLSGenerator は初期化情報より先にフレームが届いた映像を、ないものとして扱う)
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
  // 映像のフレームなら、従来の形式でも Enhanced RTMP の形式でも 5 byte 以上ある
  if (message.data.byteLength < 5) { return null; }
  const reader = new ByteReader(message.data);

  const meta = reader.readU8();
  // 先頭 1bit (IsExHeader) が立っていなければ、従来の FLV の VideoTagHeader: FrameType (4bit), CodecID (4bit)
  const isExHeader = (meta & 0x80) !== 0;
  if (!isExHeader) {
    // H.264 (AVC) 以外は fMP4 にできないので、対応していないコーデックとして返す (FrameType 5 はコマンドなので扱わない)
    const frameType = (meta & 0xF0) >> 4;
    const codecId = meta & 0x0F;
    if (codecId !== VideoCodecType.AVC && frameType !== FrameType.VIDEO_INFO_OR_COMMAND) {
      return { kind: 'Video', frameType, timestamp: message.timestamp, codec: 'Unsupported', codecId };
    }
    return handle_legacy_video(message);
  }

  // Enhanced RTMP の ExVideoTagHeader: IsExHeader (1bit), FrameType (3bit), PacketType (4bit), FourCC (32bit)
  const frameType = (meta & 0x70) >> 4;
  const packetType = meta & 0x0F;
  // FrameType 5 は映像のフレームではなくコマンドなので扱わない
  if (frameType === FrameType.VIDEO_INFO_OR_COMMAND) { return null; }
  // Multitrack の形式の映像は扱わない (このサーバが使うのは、FFmpeg 8.0 以降や OBS が Multitrack ではない形式で送る最初の映像トラックだけ)
  // (Multitrack では FourCC の前に AvMultitrackType (4bit) と PacketType (4bit) の 1 byte が入るので、ここで FourCC を読むと別の値になる)
  if (packetType === PacketType.Multitrack) { return null; }
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
      return { kind: 'Video', frameType, timestamp: message.timestamp, codec: 'Unsupported', codecId: fourcc };
  }
};

// 対応していないコーデックの音声 (MP3 など)
export type UnsupportedAudioData = {
  codec: 'Unsupported';
  soundFormat: number; // 例: 2 は MP3
};
export type AudioData = (AACData | UnsupportedAudioData) & {
  timestamp: number;
  kind: 'Audio';
};

export const handle_audio = (message: { timestamp: number; data: Buffer; }): AudioData | null => {
  if (message.data.byteLength < 1) { return null; }
  // AudioTagHeader の先頭 4bit が SoundFormat: AAC 以外はこのサーバでは fMP4 にしないので、対応していないコーデックとして返す
  // (SoundFormat 9 は Enhanced RTMP の ExAudioTagHeader で、AAC のトラックの MultichannelConfig や 2 つ目の音声トラックのこともある: HLSGenerator)
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

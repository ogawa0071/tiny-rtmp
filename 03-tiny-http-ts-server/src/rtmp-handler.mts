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
      // FFmpeg は、配信を始める時にまだ初期化情報がないと、中身が空の初期化情報を送ってくる
      // (エンコーダが初期化情報 (グローバルヘッダ) を出さない時や、ADTS の AAC (MPEG-TS や HLS の入力など) を -c copy で送る時)
      // 本当の初期化情報は、最初のフレームから取り出して、そのフレームの直前に送り直してくるので、中身が空のものは無視する
      // (H.264 の初期化情報を最初のフレームから取り出して送り直すのは FFmpeg 6.1 以降。それより前の FFmpeg は送り直さず、
      //  フレームも開始コード付き (Annex B) のまま送ってくるので、その映像は使わない: mpegts-transmuxer.mts の feed)
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
  // AVC のフレームなら VideoTagHeader (1byte), AVCPacketType (1byte), CompositionTime (3byte) が必ずある
  if (data.byteLength < 5) { return null; }
  const reader = new ByteReader(data);

  const meta = reader.readU8();
  const frameType = (meta & 0xF0) >> 4;
  const codec = meta & 0x0F;
  // FrameType 5 は映像のフレームではなくコマンド (AVCPacketType などを持たない) なので扱わない
  // また先頭 1bit が立っていれば Enhanced RTMP の ExVideoTagHeader なので、従来の形式としては扱わない
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
      // 中身が空の初期化情報は無視する (FFmpeg が ADTS の AAC を -c copy で送る時など: handle_avc)
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
  // AAC なら AudioTagHeader (1byte) と AACPacketType (1byte) が必ずある
  if (data.byteLength < 2) { return null; }
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
// ただし @setDataFrame が付いていない onMetaData (['onMetaData', { ... }]) もあるので、どちらも受け付ける
export const read_onmetadata = (values: AMF0Value[]): AMF0Object | null => {
  const [name, metadata] = values[0] === '@setDataFrame' ? values.slice(1) : values;
  if (name !== 'onMetaData' || !isAMF0Object(metadata)) { return null; }
  return metadata;
};

// RTMP の timestamp は 32bit なので、2^32 ミリ秒 (約 49.7 日) で一周して 0 に戻る (一周しても扱えるようにするべき: RTMP 仕様 4 章)
// FFmpeg は FLV と同じ 31bit で送るので、2^31 ミリ秒 (約 24.8 日) で一周する (-avoid_negative_ts disabled の時の負の DTS も 0x7FFFFFxx で届く)
// 一周して戻った timestamp のままではセグメントを区切れなくなるので、配信ごとにこのクラスで一周しない時刻に直してから使う
export class TimestampUnwrapper {
  private previous: { received: number; timestamp: number; } | null = null;
  // 最初の映像・音声の時刻と、これまでで一番進んだ時刻 (配信の最初の 1 秒の間かを見る)
  private first: number | null = null;
  private latest: number | null = null;
  private offset = 0;

  // 映像・音声の timestamp を直す (onMetaData は映像・音声と同じ時計とは限らないので、そのまま返す)
  public unwrap(message: Message): Message {
    if (message.message_type_id !== MessageType.Audio && message.message_type_id !== MessageType.Video) { return message; }
    let timestamp = message.timestamp;
    if (this.previous != null) {
      // 前の映像・音声との差を -2^30 以上 2^30 未満にして足す
      // (2^32 は 2^31 の倍数なので、2^32 と 2^31 のどちらで一周しても、一周しなかった時と同じ差になる)
      const delta = ((message.timestamp - this.previous.received) % 2 ** 31 + 2 ** 31 + 2 ** 30) % 2 ** 31 - 2 ** 30;
      timestamp = this.previous.timestamp + delta;
    }
    this.previous = { received: message.timestamp, timestamp };
    this.first ??= timestamp;
    this.latest = Math.max(this.latest ?? timestamp, timestamp);
    // 0 より前の時刻 (FFmpeg の負の DTS など) は fMP4 などで表せないので、
    // FFmpeg の -avoid_negative_ts make_non_negative と同じく、配信の最初 (1 秒の間) に届いたものが負にならないように全体をずらす
    // ずらす量は配信の最初に決めて、その後は変えない (FFmpeg も最初に決める。途中で変えると、そこから後の時刻が全部ずれて隙間ができる)
    if (this.latest - this.first < 1000) { this.offset = Math.max(this.offset, -timestamp); }
    // その後に 0 より前の時刻が届いたら (配信ソフトの不具合など)、そのメッセージだけを 0 にする
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

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import write_amf0 from '../../01-tiny-rtmp-server/src/amf0-writer.mts';
import { isAMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { write_flv_header, write_flv_tag } from '../../01-tiny-rtmp-server/src/flv-writer.mts';

// 視聴者に中継する FLV Tag
export type RelayedTag = {
  tag: Buffer;
  keyframe: boolean; // キーフレームの AVC NALU か
  initial: boolean; // 途中から視聴を始めた視聴者に最初に送る FLV Tag (onMetaData や初期化情報) か
};

// RTMP で届いたメッセージから視聴者に中継する FLV Tag を作り、途中から視聴を始めた視聴者に最初に送るものを覚えておく
export default class FLVRelay {
  // 途中から視聴を始めた視聴者に最初に送る FLV Tag
  private onMetaData: Buffer | null = null;
  private avcConfig: Buffer | null = null;
  private aacConfig: Buffer | null = null;
  // FLV Header に書く、音声・映像を送るかどうか (onMetaData が届くまでは両方あるとみなす)
  private has_audio = true;
  private has_video = true;

  // 映像の初期化情報が届いているか
  public hasVideoConfig(): boolean {
    return this.avcConfig != null;
  }

  // 視聴を始めた視聴者に最初に送る FLV Header と FLV Tag
  public initials(): Buffer[] {
    const initials = [write_flv_header(this.has_audio, this.has_video)];
    for (const tag of [this.onMetaData, this.avcConfig, this.aacConfig]) {
      if (tag != null) { initials.push(tag); }
    }
    return initials;
  }

  // 中継する FLV Tag を作る (中継しないメッセージなら null)
  public accept(message: Message): RelayedTag | null {
    switch (message.message_type_id) {
      case MessageType.Video: {
        if (message.data.byteLength < 2) { return null; }
        const [header, packetType] = message.data;
        // AVC (CodecID: 7) の映像のフレーム (FrameType: 1〜4) のみ受け付ける
        // (FrameType 5 は AVCPacketType を持たないコマンドで、先頭 1bit が立っていれば Enhanced RTMP の別の形式)
        const frameType = header >> 4;
        if ((header & 0x0F) !== 7 || frameType < 1 || frameType > 4) { return null; }
        // 中身が空の初期化情報は中継しない (途中から視聴を始めた視聴者に最初に送る初期化情報にもしない)
        // (FFmpeg は、配信を始める時にまだ初期化情報がないと空の初期化情報を送り、最初のフレームの直前に本当の初期化情報を送り直す。
        //  ただし H.264 の初期化情報を送り直すのは FFmpeg 6.1 以降で、それより前の FFmpeg はフレームも開始コード付き (Annex B) のまま送ってくるので、
        //  視聴者は再生できない: 03-tiny-http-ts-server の handle_avc)
        // (AVC の初期化情報は VideoTagHeader, AVCPacketType, CompositionTime (5 byte) の後ろに AVCDecoderConfigurationRecord が続く)
        if (packetType === 0 && message.data.byteLength <= 5) { return null; }
        const tag = write_flv_tag(message);
        if (packetType === 0) { this.avcConfig = tag; } // AVC sequence header
        return { tag, keyframe: frameType === 1 && packetType === 1, initial: packetType === 0 };
      }
      case MessageType.Audio: {
        if (message.data.byteLength < 2) { return null; }
        const [header, packetType] = message.data;
        if ((header >> 4) !== 10) { return null; } // AAC (SoundFormat: 10) のみ受け付ける
        // 中身が空の初期化情報は中継しない (AudioTagHeader, AACPacketType (2 byte) の後ろに AudioSpecificConfig がないもの: 映像と同じ)
        if (packetType === 0 && message.data.byteLength <= 2) { return null; }
        const tag = write_flv_tag(message);
        if (packetType === 0) { this.aacConfig = tag; } // AAC sequence header
        return { tag, keyframe: false, initial: packetType === 0 };
      }
      case MessageType.DataAMF0: {
        // 配信ソフトは @setDataFrame 付きで送ってくるが、付いていない onMetaData もあるので、どちらも受け付ける
        const [name, metadata] = message.data[0] === '@setDataFrame' ? message.data.slice(1) : message.data;
        if (name !== 'onMetaData' || !isAMF0Object(metadata)) { return null; }
        // FLV には @setDataFrame を除いた onMetaData を書き込む
        const tag = write_flv_tag({ ... message, data: write_amf0(name, metadata) });
        this.onMetaData = tag;
        // 中継するのは AAC (SoundFormat: 10) と AVC (CodecID: 7) だけなので、それ以外のコーデックなら送らないことを伝える
        // (コーデックを 'mp4a' や 'avc1' の文字列で書く配信ソフトもある)
        // コーデックが 1 つも書かれていない onMetaData (yasea などの配信ソフトや、曲名だけを送り直す配信ソフト) では変えない
        if (metadata.audiocodecid != null || metadata.videocodecid != null) {
          this.has_audio = metadata.audiocodecid === 10 || metadata.audiocodecid === 'mp4a';
          this.has_video = metadata.videocodecid === 7 || metadata.videocodecid === 'avc1';
        }
        return { tag, keyframe: false, initial: true };
      }
      default: return null;
    }
  }
}

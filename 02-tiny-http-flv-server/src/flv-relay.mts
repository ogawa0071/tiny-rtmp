import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import write_amf0 from '../../01-tiny-rtmp-server/src/amf0-writer.mts';
import { isAMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { write_flv_header, write_flv_tag } from '../../01-tiny-rtmp-server/src/flv-writer.mts';

export type RelayedTag = {
  tag: Buffer;
  keyframe: boolean;
  initial: boolean;
};

export default class FLVRelay {
  private onMetaData: Buffer | null = null;
  private avcConfig: Buffer | null = null;
  private aacConfig: Buffer | null = null;
  private has_audio = true;
  private has_video = true;

  public hasVideoConfig(): boolean {
    return this.avcConfig != null;
  }

  public initials(): Buffer[] {
    const initials = [write_flv_header(this.has_audio, this.has_video)];
    for (const tag of [this.onMetaData, this.avcConfig, this.aacConfig]) {
      if (tag != null) { initials.push(tag); }
    }
    return initials;
  }

  public accept(message: Message): RelayedTag | null {
    switch (message.message_type_id) {
      case MessageType.Video: {
        if (message.data.byteLength < 2) { return null; }
        const [header, packetType] = message.data;
        const frameType = header >> 4;
        if ((header & 0x0F) !== 7 || frameType < 1 || frameType > 4) { return null; }
        if (packetType === 0 && message.data.byteLength <= 5) { return null; }
        const tag = write_flv_tag(message);
        if (packetType === 0) { this.avcConfig = tag; }
        return { tag, keyframe: frameType === 1 && packetType === 1, initial: packetType === 0 };
      }
      case MessageType.Audio: {
        if (message.data.byteLength < 2) { return null; }
        const [header, packetType] = message.data;
        if ((header >> 4) !== 10) { return null; }
        if (packetType === 0 && message.data.byteLength <= 2) { return null; }
        const tag = write_flv_tag(message);
        if (packetType === 0) { this.aacConfig = tag; }
        return { tag, keyframe: false, initial: packetType === 0 };
      }
      case MessageType.DataAMF0: {
        const [name, metadata] = message.data[0] === '@setDataFrame' ? message.data.slice(1) : message.data;
        if (name !== 'onMetaData' || !isAMF0Object(metadata)) { return null; }
        const tag = write_flv_tag({ ... message, data: write_amf0(name, metadata) });
        this.onMetaData = tag;
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

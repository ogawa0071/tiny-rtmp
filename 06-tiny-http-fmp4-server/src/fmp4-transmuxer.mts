import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import handle_rtmp_payload, { AACPacketType, FrameType, PacketType, read_onmetadata } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import { write_mp4_aac_track_information } from './aac.mts';
import { fragment, initialize, make } from './fmp4.mts';
import { write_mp4_avc_track_information } from './avc.mts';

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const VIDEO_TRACK_ID = 1;
const AUDIO_TRACK_ID = 2;

// 視聴者に送る fMP4 の断片 (moof + mdat)
export type FMP4Fragment = {
  data: Buffer;
  // ここから送り始めてもデコードできるか (映像のキーフレームか、映像のない配信の音声のフレーム)
  independent: boolean;
};

export default class FMP4Transmuxer {
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;

  private initializeSegment: Buffer | null = null;
  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;
  private sequenceNumber = 0; // mfhd の sequence_number (moof ごとに 1 から増やす)

  public initialize(): Buffer | null {
    return this.initializeSegment;
  }

  // onMetaData に書かれている全てのコーデックの初期化情報が揃ったら、初期化セグメント (ftyp + moov) を作る
  private create_initialize_segment(): Buffer | null {
    if (this.onMetadata == null) { return null; }

    const tracks = new Map<number, Buffer>();
    if (this.onMetadata.videocodecid != null) {
      if (this.avcDecoderConfigurationRecord == null) { return null; }
      tracks.set(VIDEO_TRACK_ID, write_mp4_avc_track_information(VIDEO_TRACK_ID, RTMP_TIMESCALE, this.avcDecoderConfigurationRecord));
    }
    if (this.onMetadata.audiocodecid != null) {
      if (this.audioSpecificConfig == null) { return null; }
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      tracks.set(AUDIO_TRACK_ID, write_mp4_aac_track_information(AUDIO_TRACK_ID, samplingFrequency, this.audioSpecificConfig));
    }

    return make((vector) => {
      initialize(RTMP_TIMESCALE, [... tracks.keys()], vector, (vector) => {
        for (const track of tracks.values()) { vector.write(track); }
      });
    });
  }

  public feed(message: Message): FMP4Fragment | null {
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return null; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return null;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return null;
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        if (metadata != null) { this.onMetadata = metadata; }
        return null;
      }
    }

    this.initializeSegment ??= this.create_initialize_segment();
    if (this.initializeSegment == null) { return null; }

    switch (payload.kind) {
      case 'Video': {
        if (this.avcDecoderConfigurationRecord == null) { return null; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        const previous = this.previousVideoInformation;
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        if (previous == null) { return null; }

        const { type, dts, cto, data } = previous;
        const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
        const keyframe = type === FrameType.KEY_FRAME;
        return {
          data: make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: VIDEO_TRACK_ID, keyframe, duration, dts, cto }, data, vector);
          }),
          independent: keyframe,
        };
      }
      case 'Audio': {
        if (this.audioSpecificConfig == null) { return null; }
        // AAC は 1 フレームが 1024 サンプルなので、前のフレームから 1024 ずつ進める
        // ただし、音声が途切れるなどで RTMP の timestamp と 1 フレーム以上ずれたら、RTMP の timestamp に合わせ直す
        const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
        const timestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        if (this.aacLatestTimestamp == null || Math.abs(this.aacLatestTimestamp + 1024 - timestamp) > 1024) {
          this.aacLatestTimestamp = timestamp;
        } else {
          this.aacLatestTimestamp += 1024;
        }
        const dts = this.aacLatestTimestamp;
        return {
          data: make((vector) => {
            fragment({ sequence_number: ++this.sequenceNumber, track_id: AUDIO_TRACK_ID, keyframe: true, duration: 1024, dts, cto: 0 }, payload.data, vector);
          }),
          // 映像がある時は、映像のキーフレームから送り始める
          independent: this.onMetadata?.videocodecid == null,
        };
      }
    }
  }
}

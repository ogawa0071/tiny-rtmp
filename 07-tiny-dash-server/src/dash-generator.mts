import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import type { AMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';

import { read_audio_specific_config } from '../../03-tiny-http-ts-server/src/aac.mts';
import { read_avc_decoder_configuration_record } from '../../03-tiny-http-ts-server/src/avc.mts';
import handle_rtmp_payload, { AACPacketType, AudioCodecType, FrameType, PacketType, read_onmetadata, TimestampUnwrapper } from '../../03-tiny-http-ts-server/src/rtmp-handler.mts';

import { fragment, initialize, make } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';
import { write_mp4_avc_track_information } from '../../06-tiny-http-fmp4-server/src/avc.mts';
import { write_mp4_aac_track_information } from '../../06-tiny-http-fmp4-server/src/aac.mts';

import SegmentTimeline from './segment-timeline.mts';
import { serializeXML, XMLNode } from './xml.mts';
import { aacMimeTypeCodec, avcMimeTypeCodec } from './mimetype.mts';

type VideoInformation = {
  type: number;
  dts: number;
  cto: number;
  data: Buffer;
};

const RTMP_TIMESCALE = 1000;
const AAC_SAMPLES_PER_FRAME = 1024;

export default class DASHGenerator {
  private timestamps = new TimestampUnwrapper();
  private avcDecoderConfigurationRecord: Buffer | null = null;
  private audioSpecificConfig: Buffer | null = null;
  private onMetadata: AMF0Object | null = null;
  // 最初に届いた音声のメッセージの SoundFormat (AudioTagHeader の先頭 4bit: 10 は AAC、2 は MP3、9 は Enhanced RTMP の形式)
  private firstAudioFormat: number | null = null;
  // MPD に載せるトラック (MPD を作れるようになった時に決めて、後から増やしたり減らしたりしない: decideTracks)
  private tracks: { video: boolean; audio: boolean; } | null = null;

  private previousVideoInformation: VideoInformation | null = null;
  private aacLatestTimestamp: number | null = null;
  // 映像を区切ったので、次に届く音声フレームから音声も新しいセグメントにする
  private audioCutPending = false;
  // moof の sequence_number (Representation ごとに 1 から増やす)
  private videoSequenceNumber = 0;
  private audioSequenceNumber = 0;

  private liveWindowLength: number;
  private videoTimeline: SegmentTimeline | null = null;
  private audioTimeline: SegmentTimeline | null = null;

  // availabilityStartTime は RTMP の timestamp が 0 になる時刻 (最初のメディアが届いた時に決める)
  private availabilityStartTime: Temporal.Instant | null = null;
  // 配信ごとに変わる値 (配信をやり直すと同じ URL で中身が変わらないように、セグメントの URL に含める)
  public readonly session = `${Date.now()}`;

  public constructor(liveWindowLength: number = 3) {
    this.liveWindowLength = liveWindowLength;
  }

  // MPD に載せる映像のトラックがあるか
  // onMetaData にこのサーバで扱える AVC と書かれていれば、初期化情報が遅れて届いても待つ (コーデックを数値ではなく 'avc1' の文字列で送ってくる配信ソフトもある)
  // onMetaData に書かれていなくても、初期化情報が届いていれば載せる (onMetaData を送ってこない配信ソフトや、onMetaData にコーデックを書かない配信ソフト (yasea など) もある)
  private hasVideo(): boolean {
    if (this.tracks != null) { return this.tracks.video; }
    return this.avcDecoderConfigurationRecord != null || this.onMetadata?.videocodecid === 7 || this.onMetadata?.videocodecid === 'avc1';
  }

  // MPD に載せる音声のトラックがあるか (hasVideo と同じ。コーデックを数値ではなく 'mp4a' の文字列で送ってくる配信ソフトもある)
  private hasAudio(): boolean {
    if (this.tracks != null) { return this.tracks.audio; }
    if (this.audioSpecificConfig != null) { return true; }
    // 音声がもう届いていれば、onMetaData ではなく最初に届いた音声のコーデックで決める
    // (onMetaData に AAC と書かれていても、最初に AAC 以外の音声が届いたなら AAC は届かない。
    //  onMetaData に書かれていなくても、最初に AAC が届いたなら待つ: 中身が空の初期化情報が先に届いても、本当の初期化情報は後から届く)
    if (this.firstAudioFormat != null) { return this.firstAudioFormat === AudioCodecType.AAC; }
    return this.onMetadata?.audiocodecid === 10 || this.onMetadata?.audiocodecid === 'mp4a';
  }

  // SegmentTimeline には S が 1 つ以上必要なので、MPD に載せる全てのトラックにセグメントができるまでは MPD を作らない
  // (トラックを後から MPD に足しても再生を始めたプレイヤーには使われないので、初期化情報が遅れて届くトラックも待つ)
  // MPD を作れるようになったら、MPD に載せるトラックを決めて、後から変えない
  // (視聴者が最初に MPD を取りに来た時刻によって載せるトラックが変わらないように、映像・音声が届いた時に決める)
  private decideTracks(): void {
    if (this.tracks != null) { return; }
    if (!this.hasVideo() && !this.hasAudio()) { return; }
    if (this.hasVideo() && !(this.videoTimeline?.hasSegments() ?? false)) { return; }
    if (this.hasAudio() && !(this.audioTimeline?.hasSegments() ?? false)) { return; }
    this.tracks = { video: this.hasVideo(), audio: this.hasAudio() };
  }

  // MPD を作る (まだ MPD に載せるトラックが決まっていなければ null)
  public mpd(): string | null {
    if (this.tracks == null) { return null; }

    const declaration = '<?xml version="1.0" encoding="UTF-8"?>';

    const mpd = XMLNode.from('MPD', {
      xmlns: 'urn:mpeg:dash:schema:mpd:2011',
      'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      'xsi:schemaLocation': 'urn:mpeg:dash:schema:mpd:2011 http://standards.iso.org/ittf/PubliclyAvailableStandards/MPEG-DASH_schema_files/DASH-MPD.xsd',
      profiles: 'urn:mpeg:dash:profile:isoff-live:2011',
      type: 'dynamic',
      availabilityStartTime: (this.availabilityStartTime ?? Temporal.Now.instant()).toString({ smallestUnit: 'millisecond' }),
      publishTime: Temporal.Now.instant().toString({ smallestUnit: 'millisecond' }),
      minimumUpdatePeriod: 'PT1S',
      minBufferTime: 'PT2S',
    });
    // type="dynamic" の MPD では Period@id が必須
    const period = XMLNode.from('Period', { id: '0', start: 'PT0S' });

    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline != null) {
      const avcDecoderConfigurationRecord = read_avc_decoder_configuration_record(this.avcDecoderConfigurationRecord);
      const video_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'video',
        mimeType: 'video/mp4',
      });
      const video_representation = XMLNode.from('Representation', {
        id: '1',
        codecs: avcMimeTypeCodec(avcDecoderConfigurationRecord),
        bandwidth: `${this.videoTimeline.bandwidth()}`, // Representation@bandwidth は必須
      });

      video_representation.children.push(this.videoTimeline.segment_template());
      video_adaptationset.children.push(video_representation);
      period.children.push(video_adaptationset);
    }
    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline != null) {
      const audioSpecificConfig = read_audio_specific_config(this.audioSpecificConfig);
      const audio_adaptationset = XMLNode.from('AdaptationSet', {
        contentType: 'audio',
        mimeType: 'audio/mp4',
      });

      const audio_representation = XMLNode.from('Representation', {
        id: '2',
        codecs: aacMimeTypeCodec(audioSpecificConfig),
        bandwidth: `${this.audioTimeline.bandwidth()}`, // Representation@bandwidth は必須
      });
      audio_representation.children.push(this.audioTimeline.segment_template());
      audio_adaptationset.children.push(audio_representation);
      period.children.push(audio_adaptationset);
    }
    mpd.children.push(period);

    return declaration + '\n' + serializeXML(mpd);
  }

  public segment(type: string, msn: number): Buffer | null {
    switch (type) {
      case 'video': return this.videoTimeline?.segment(msn) ?? null;
      case 'audio': return this.audioTimeline?.segment(msn) ?? null;
      default: return null;
    }
  }

  public initialize(type: string): Buffer | null {
    switch (type) {
      case 'video': return this.videoTimeline?.initialize() ?? null;
      case 'audio': return this.audioTimeline?.initialize() ?? null;
      default: return null;
    }
  }

  public feed(received: Message): void {
    // RTMP の timestamp が一周して戻っても (rtmp-handler.mts の TimestampUnwrapper)、時刻が戻らないように直してから使う
    const message = this.timestamps.unwrap(received);
    // 音声のコーデックは、最初に届いた音声のメッセージで決める (06 や 09 と同じ)
    // (handle_rtmp_payload は AAC 以外の音声や中身が空の AAC の初期化情報には null を返すので、AudioTagHeader の先頭 4bit の SoundFormat を見る)
    // (AAC の配信でも、FFmpeg 8.0 以降の 5.1ch などの MultichannelConfig や、OBS や FFmpeg の 2 つ目の音声トラックは、Enhanced RTMP の形式 (SoundFormat 9) で届く。
    //  ADTS の AAC (MPEG-TS や HLS の入力など) を -c copy で送る時は、それが本当の AAC の初期化情報より先に届くが、その前に中身が空の AAC の初期化情報が届く)
    if (message.message_type_id === MessageType.Audio && message.data.byteLength >= 1) {
      this.firstAudioFormat ??= message.data[0] >> 4;
    }
    const payload = handle_rtmp_payload(message);
    if (payload == null) { return; }

    // 初期化セグメントに必要な情報を集める
    switch (payload.kind) {
      case 'Video':
        if (payload.packetType === PacketType.SequenceStart) {
          this.avcDecoderConfigurationRecord = payload.avcDecoderConfigurationRecord;
          return;
        }
        break;
      case 'Audio':
        if (payload.packetType === AACPacketType.SequenceHeader) {
          this.audioSpecificConfig = payload.audioSpecificConfig;
          return;
        }
        break;
      case 'Data': {
        const metadata = read_onmetadata(payload.values);
        // 最初の onMetaData を使う (配信の途中で onMetaData が送り直されても、MPD に載せるトラックを増やしたり減らしたりしない)
        if (metadata != null) { this.onMetadata ??= metadata; }
        return;
      }
    }

    // RTMP の timestamp は 0 から始まるとは限らないので、timestamp が 0 になる時刻を availabilityStartTime にする
    this.availabilityStartTime ??= Temporal.Now.instant().subtract({ milliseconds: payload.timestamp });

    // 初期化情報が揃ったトラックから、初期化セグメントを作ってセグメントを並べ始める
    if (this.hasVideo() && this.avcDecoderConfigurationRecord != null && this.videoTimeline == null) {
      const initialization = make((vector) => {
        initialize(RTMP_TIMESCALE, [1], vector, (vector) => {
          vector.write(write_mp4_avc_track_information(1, RTMP_TIMESCALE, this.avcDecoderConfigurationRecord!));
        });
      });
      this.videoTimeline = new SegmentTimeline(`video_${this.session}`, RTMP_TIMESCALE, initialization, { liveWindowLength: this.liveWindowLength });
    }
    if (this.hasAudio() && this.audioSpecificConfig != null && this.audioTimeline == null) {
      const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
      const initialization = make((vector) => {
        initialize(samplingFrequency, [1], vector, (vector) => {
          vector.write(write_mp4_aac_track_information(1, samplingFrequency, this.audioSpecificConfig!));
        });
      });
      this.audioTimeline = new SegmentTimeline(`audio_${this.session}`, samplingFrequency, initialization, { liveWindowLength: this.liveWindowLength });
    }

    switch (payload.kind) {
      case 'Video': {
        if (this.videoTimeline == null) { return; }
        // フレームの長さ (duration) は次のフレームとの差でわかるので、1 つ前のフレームをここで書き出す
        if (this.previousVideoInformation != null) {
          const { type, dts, cto, data } = this.previousVideoInformation;
          const duration = Math.max(0, payload.timestamp - dts); // timestamp が戻っても負の長さにしない
          this.videoTimeline.feed(make((vector) => {
            fragment({ sequence_number: ++this.videoSequenceNumber, track_id: 1, keyframe: type === FrameType.KEY_FRAME, duration, dts, cto }, data, vector);
          }));
        }
        // 1 つ前のフレームを今のセグメントに書き出してから、キーフレームで新しいセグメントを始める
        // 映像を区切った時は音声も区切る (次に届く音声フレームから新しいセグメントに入れる)
        if (payload.frameType === FrameType.KEY_FRAME && this.videoTimeline.append(payload.timestamp)) {
          this.audioCutPending = true;
        }
        this.previousVideoInformation = {
          type: payload.frameType,
          dts: payload.timestamp,
          cto: payload.compositionTimeOffset,
          data: payload.data,
        };
        break;
      }
      case 'Audio': {
        if (this.audioTimeline == null) { return; }
        if (this.audioSpecificConfig == null) { return; }
        // AAC は 1 フレームが 1024 サンプルなので、前のフレームから 1024 ずつ進める
        // ただし音声が途切れた時などに RTMP の timestamp と 1 フレーム以上ずれたら、RTMP の timestamp に合わせ直す
        const { samplingFrequency } = read_audio_specific_config(this.audioSpecificConfig);
        const timestamp = Math.floor(payload.timestamp * samplingFrequency / 1000);
        if (this.aacLatestTimestamp == null) {
          // 最初の音声フレームからセグメントを始める (映像のキーフレームを待つと、それまでの音声が捨てられる)
          this.audioTimeline.append(timestamp);
        }
        if (this.aacLatestTimestamp == null || Math.abs(this.aacLatestTimestamp + AAC_SAMPLES_PER_FRAME - timestamp) > AAC_SAMPLES_PER_FRAME) {
          this.aacLatestTimestamp = timestamp;
        } else {
          this.aacLatestTimestamp += AAC_SAMPLES_PER_FRAME;
        }
        const dts = this.aacLatestTimestamp;
        // 映像を区切った後の最初の音声フレームから、音声も新しいセグメントにする
        // (区切るのをこのフレームの時刻にすれば、音声が途切れた後でもセグメントの開始時刻 S@t と最初のフレームの時刻が一致する)
        // 音声のフレームの区切りは映像と揃わず 1 秒より少し短くなることがあるので、最小の長さは確認しない
        if (this.audioCutPending) {
          this.audioTimeline.append(dts, true);
          this.audioCutPending = false;
        }
        // 映像がない (またはこのサーバで扱えない AVC 以外の映像の) 配信では、音声だけで (1 秒以上たったら) セグメントを区切る
        if (!this.hasVideo()) { this.audioTimeline.append(dts); }
        this.audioTimeline.feed(make((vector) => {
          fragment({ sequence_number: ++this.audioSequenceNumber, track_id: 1, keyframe: true, duration: AAC_SAMPLES_PER_FRAME, dts, cto: 0 }, payload.data, vector);
        }));
        break;
      }
    }
    // 映像・音声でセグメントができたら、MPD に載せるトラックを決める
    this.decideTracks();
  }
}

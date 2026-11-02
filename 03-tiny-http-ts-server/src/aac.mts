import BitBuilder from './bit-builder.mts';
import BitReader from './bit-reader.mts';

const samplingFrequencyTable = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
  16000, 12000, 11025, 8000, 7350,
] as const;

export type AudioSpecificConfig = {
  audioObjectType: number;
  samplingFrequencyIndex: number;
  samplingFrequency: number;
  channelConfiguration: number;
  coreAudioObjectType: number;
  programConfigElement: Buffer | null;
};

const read_audio_object_type = (reader: BitReader): number => {
  const audioObjectType = reader.readBits(5);
  return audioObjectType === 31 ? 32 + reader.readBits(6) : audioObjectType;
};

const read_program_config_element = (reader: BitReader): Buffer => {
  const builder = new BitBuilder();
  const copy = (length: number): number => {
    const value = reader.readBits(length);
    builder.writeBits(value, length);
    return value;
  };

  builder.writeBits(0b101, 3);
  copy(4);
  copy(2);
  copy(4);
  const front = copy(4);
  const side = copy(4);
  const back = copy(4);
  const lfe = copy(2);
  const assoc = copy(3);
  const cc = copy(4);
  if (copy(1)) { copy(4); }
  if (copy(1)) { copy(4); }
  if (copy(1)) { copy(3); }
  for (let i = 0; i < front + side + back; i++) { copy(5); }
  for (let i = 0; i < lfe + assoc; i++) { copy(4); }
  for (let i = 0; i < cc; i++) { copy(5); }
  reader.skipByteAlign();
  builder.writeByteAlign();
  const comment_field_bytes = copy(8);
  for (let i = 0; i < comment_field_bytes; i++) { copy(8); }
  return builder.build();
};

export const read_audio_specific_config = (audioSpecificConfig: Buffer): AudioSpecificConfig => {
  const reader = new BitReader(audioSpecificConfig);

  const audioObjectType = read_audio_object_type(reader);
  const samplingFrequencyIndex = reader.readBits(4);
  const samplingFrequency = samplingFrequencyIndex === 0x0f ? reader.readBits(24) : samplingFrequencyTable[samplingFrequencyIndex];
  const channelConfiguration = reader.readBits(4);

  let coreAudioObjectType = audioObjectType;
  if (audioObjectType === 5 || audioObjectType === 29) {
    const extensionSamplingFrequencyIndex = reader.readBits(4);
    if (extensionSamplingFrequencyIndex === 0x0f) { reader.readBits(24); }
    coreAudioObjectType = read_audio_object_type(reader);
  }

  let programConfigElement: Buffer | null = null;
  if (channelConfiguration === 0 && 1 <= coreAudioObjectType && coreAudioObjectType <= 4) {
    try {
      reader.skipBits(1);
      if (reader.readBool()) { reader.skipBits(14); }
      reader.skipBits(1);
      programConfigElement = read_program_config_element(reader);
    } catch {
    }
  }

  return {
    audioObjectType,
    samplingFrequencyIndex,
    samplingFrequency,
    channelConfiguration,
    coreAudioObjectType,
    programConfigElement,
  };
};

export const write_adts_aac = (data: Buffer, audioSpecificConfig: AudioSpecificConfig): Buffer => {
  const builder = new BitBuilder();

  // TODO: AAC-LC or Main で samplingFrequencyIndex !== 0x0F なものに絞るべき
  const { coreAudioObjectType, samplingFrequencyIndex, channelConfiguration } = audioSpecificConfig;
  const pce = audioSpecificConfig.programConfigElement ?? Buffer.alloc(0);
  const frameLength = 7 + pce.byteLength + data.byteLength;

  builder.writeBits(0xFFF, 12); // syncword
  builder.writeBits(0, 1); // mpeg_version
  builder.writeBits(0, 2); // layer
  builder.writeBits(1, 1); // protection_absent (protected = 0)
  builder.writeBits(coreAudioObjectType - 1, 2); // profile
  builder.writeBits(samplingFrequencyIndex, 4); // sampling_frequency_index
  builder.writeBits(0, 1); // private_bit
  builder.writeBits(channelConfiguration, 3); // channel_configuration
  builder.writeBits(0, 1); // original/copy
  builder.writeBits(0, 1); // home
  builder.writeBits(0, 1); // copyright_identification_bit
  builder.writeBits(0, 1); // copyright_identification_start
  builder.writeBits(frameLength, 13); // frame_length
  builder.writeBits(0x7FF, 11); // adts_buffer_fullness
  builder.writeBits(0, 2); // number_of_raw_data_blocks_in_frame

  return Buffer.concat([builder.build(), pce, data]);
};

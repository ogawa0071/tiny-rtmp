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
  coreAudioObjectType: number; // HE-AAC の時は、SBR/PS で拡張される元の AAC の Audio Object Type
};

const read_audio_object_type = (reader: BitReader): number => {
  const audioObjectType = reader.readBits(5);
  return audioObjectType === 31 ? 32 + reader.readBits(6) : audioObjectType;
};

export const read_audio_specific_config = (audioSpecificConfig: Buffer): AudioSpecificConfig => {
  const reader = new BitReader(audioSpecificConfig);

  const audioObjectType = read_audio_object_type(reader);
  const samplingFrequencyIndex = reader.readBits(4);
  const samplingFrequency = samplingFrequencyIndex === 0x0f ? reader.readBits(24) : samplingFrequencyTable[samplingFrequencyIndex];
  const channelConfiguration = reader.readBits(4);

  // HE-AAC (5: SBR, 29: SBR+PS) は、拡張後のサンプリング周波数の後ろに元の AAC の Audio Object Type が続く
  let coreAudioObjectType = audioObjectType;
  if (audioObjectType === 5 || audioObjectType === 29) {
    const extensionSamplingFrequencyIndex = reader.readBits(4);
    if (extensionSamplingFrequencyIndex === 0x0f) { reader.readBits(24); } // extensionSamplingFrequency
    coreAudioObjectType = read_audio_object_type(reader);
  }

  return {
    audioObjectType,
    samplingFrequencyIndex,
    samplingFrequency,
    channelConfiguration,
    coreAudioObjectType,
  };
};

export const write_adts_aac = (data: Buffer, audioSpecificConfig: AudioSpecificConfig): Buffer => {
  const builder = new BitBuilder();

  // TODO: AAC-LC or Main で samplingFrequencyIndex !== 0x0F なものに絞るべき
  // ADTS には SBR/PS を書く場所がないので、HE-AAC は元の AAC として書く (デコーダが SBR/PS を見つけて拡張する)
  const { coreAudioObjectType, samplingFrequencyIndex, channelConfiguration } = audioSpecificConfig;
  const frameLength = 7 + data.byteLength;

  builder.writeBits(0xFFF, 12); // syncword
  builder.writeBits(0, 1); // ID (0: MPEG-4 AAC, 1: MPEG-2 AAC)
  builder.writeBits(0, 2); // layer
  builder.writeBits(1, 1); // protection_absent (protected = 0)
  builder.writeBits(coreAudioObjectType - 1, 2); // profile (Audio Object Type - 1)
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

  return Buffer.concat([builder.build(), data]);
};

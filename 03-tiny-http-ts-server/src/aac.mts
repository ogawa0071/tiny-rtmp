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
  // channelConfiguration が 0 の時に、チャンネル構成を示す program_config_element
  // (ADTS では raw_data_block の先頭に置くので、その形 (ID_PCE から始まる) に書き直したもの)
  programConfigElement: Buffer | null;
};

const read_audio_object_type = (reader: BitReader): number => {
  const audioObjectType = reader.readBits(5);
  return audioObjectType === 31 ? 32 + reader.readBits(6) : audioObjectType;
};

// AudioSpecificConfig の中の program_config_element を、ADTS の raw_data_block に置く要素に書き直す
// byte_alignment() はそれぞれの先頭 (AudioSpecificConfig / raw_data_block) からの位置で揃えるので、ビット列をそのままは使えない
const read_program_config_element = (reader: BitReader): Buffer => {
  const builder = new BitBuilder();
  const copy = (length: number): number => {
    const value = reader.readBits(length);
    builder.writeBits(value, length);
    return value;
  };

  builder.writeBits(0b101, 3); // id_syn_ele (ID_PCE)
  copy(4); // element_instance_tag
  copy(2); // object_type
  copy(4); // sampling_frequency_index
  const front = copy(4); // num_front_channel_elements
  const side = copy(4); // num_side_channel_elements
  const back = copy(4); // num_back_channel_elements
  const lfe = copy(2); // num_lfe_channel_elements
  const assoc = copy(3); // num_assoc_data_elements
  const cc = copy(4); // num_valid_cc_elements
  if (copy(1)) { copy(4); } // mono_mixdown_present, mono_mixdown_element_number
  if (copy(1)) { copy(4); } // stereo_mixdown_present, stereo_mixdown_element_number
  if (copy(1)) { copy(3); } // matrix_mixdown_idx_present, matrix_mixdown_idx, pseudo_surround_enable
  for (let i = 0; i < front + side + back; i++) { copy(5); } // *_element_is_cpe, *_element_tag_select
  for (let i = 0; i < lfe + assoc; i++) { copy(4); } // lfe_element_tag_select, assoc_data_element_tag_select
  for (let i = 0; i < cc; i++) { copy(5); } // cc_element_is_ind_sw, valid_cc_element_tag_select
  reader.skipByteAlign(); // byte_alignment()
  builder.writeByteAlign(); // byte_alignment()
  const comment_field_bytes = copy(8);
  for (let i = 0; i < comment_field_bytes; i++) { copy(8); } // comment_field_data
  return builder.build();
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

  // channelConfiguration が 0 の時は、GASpecificConfig の中の program_config_element でチャンネル構成を示す
  let programConfigElement: Buffer | null = null;
  if (channelConfiguration === 0 && 1 <= coreAudioObjectType && coreAudioObjectType <= 4) {
    try {
      reader.skipBits(1); // frameLengthFlag
      if (reader.readBool()) { reader.skipBits(14); } // dependsOnCoreCoder, coreCoderDelay
      reader.skipBits(1); // extensionFlag
      programConfigElement = read_program_config_element(reader);
    } catch {
      // program_config_element が壊れていても、映像の配信は続けられるようにチャンネル構成なしとして扱う
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
  // ADTS には SBR/PS を書く場所がないので、HE-AAC は元の AAC として書く (デコーダが SBR/PS を見つけて拡張する)
  const { coreAudioObjectType, samplingFrequencyIndex, channelConfiguration } = audioSpecificConfig;
  // channelConfiguration が 0 の時は、チャンネル構成 (program_config_element) を raw_data_block の先頭に入れる
  // (FFmpeg は最初のフレームにだけ入れるが、途中から受信してもデコードできるように全てのフレームに入れる)
  const pce = audioSpecificConfig.programConfigElement ?? Buffer.alloc(0);
  const frameLength = 7 + pce.byteLength + data.byteLength;

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

  return Buffer.concat([builder.build(), pce, data]);
};

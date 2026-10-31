import ByteReader from '../../01-tiny-rtmp-server/src/byte-reader.mts';
import EBSPBitReader from '../../06-tiny-http-fmp4-server/src/ebsp-bit-reader.mts';
import { box, make, track, visualSampleEntry } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';

// VPS/SPS/PPS の nal_unit_type (H.265 Table 7-1)
const VPS_NUT = 32;
const SPS_NUT = 33;
const PPS_NUT = 34;

// HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 8.3.3.1) から最初の SPS を取り出す
const find_sps = (hevcDecoderConfigurationRecord: Buffer): Buffer | null => {
  const reader = new ByteReader(hevcDecoderConfigurationRecord);
  reader.read(22); // configurationVersion から lengthSizeMinusOne までの固定長の部分
  const numOfArrays = reader.readU8();
  for (let i = 0; i < numOfArrays; i++) {
    const nal_unit_type = reader.readU8() & 0x3F; // array_completeness (1bit), reserved (1bit), NAL_unit_type (6bit)
    const numNalus = reader.readU16BE();
    for (let j = 0; j < numNalus; j++) {
      const nalu = reader.read(reader.readU16BE());
      if (nal_unit_type === SPS_NUT) { return nalu; }
    }
  }
  return null;
};

// SPS (H.265 7.3.2.2) の先頭から、クロップした後の解像度を読む
const read_resolution = (sps: Buffer): [width: number, height: number] => {
  const reader = new EBSPBitReader(sps.subarray(2)); // NAL Unit Header (2byte) を飛ばす
  reader.skipBits(4); // sps_video_parameter_set_id
  const sps_max_sub_layers_minus1 = reader.readBits(3);
  reader.skipBool(); // sps_temporal_id_nesting_flag
  // profile_tier_level(1, sps_max_sub_layers_minus1) (H.265 7.3.3)
  reader.skipBits(88); // general_profile_space から general_inbld_flag (または reserved) まで
  reader.skipBits(8); // general_level_idc
  const sub_layers = Array.from({ length: sps_max_sub_layers_minus1 }, () => {
    return { profile_present: reader.readBool(), level_present: reader.readBool() };
  });
  if (sps_max_sub_layers_minus1 > 0) { reader.skipBits(2 * (8 - sps_max_sub_layers_minus1)); } // reserved_zero_2bits
  for (const { profile_present, level_present } of sub_layers) {
    if (profile_present) { reader.skipBits(88); } // sub_layer_profile_space から sub_layer_inbld_flag (または reserved) まで
    if (level_present) { reader.skipBits(8); } // sub_layer_level_idc
  }
  reader.skipUEG(); // sps_seq_parameter_set_id
  const chroma_format_idc = reader.readUEG();
  if (chroma_format_idc === 3) { reader.skipBool(); } // separate_colour_plane_flag
  const pic_width_in_luma_samples = reader.readUEG();
  const pic_height_in_luma_samples = reader.readUEG();
  const conformance_window_flag = reader.readBool();
  if (!conformance_window_flag) { return [pic_width_in_luma_samples, pic_height_in_luma_samples]; }
  // クロップする量の単位は色差の間引き方で変わる (4:2:0 は縦横 2, 4:2:2 は横だけ 2, それ以外は 1)
  const SubWidthC = chroma_format_idc === 1 || chroma_format_idc === 2 ? 2 : 1;
  const SubHeightC = chroma_format_idc === 1 ? 2 : 1;
  const left = reader.readUEG();
  const right = reader.readUEG();
  const top = reader.readUEG();
  const bottom = reader.readUEG();
  return [pic_width_in_luma_samples - SubWidthC * (left + right), pic_height_in_luma_samples - SubHeightC * (top + bottom)];
};

// hvc1 では VPS/SPS/PPS を全て hvcC に入れて映像データの中には入れない決まりで、その配列の array_completeness は 1 にする (ISO/IEC 14496-15)
// FFmpeg などは映像データの中にもあってよい 0 (hev1 向けの値) で送ってくるので、コピーして 1 に書き換える
const complete_parameter_set_arrays = (hevcDecoderConfigurationRecord: Buffer): Buffer => {
  const record = Buffer.from(hevcDecoderConfigurationRecord);
  const reader = new ByteReader(record);
  reader.read(22); // configurationVersion から lengthSizeMinusOne までの固定長の部分
  const numOfArrays = reader.readU8();
  for (let i = 0; i < numOfArrays; i++) {
    const header = reader.read(1); // array_completeness (1bit), reserved (1bit), NAL_unit_type (6bit) (record の一部なので、書き換えると record も変わる)
    const nal_unit_type = header[0] & 0x3F;
    if (nal_unit_type === VPS_NUT || nal_unit_type === SPS_NUT || nal_unit_type === PPS_NUT) { header[0] |= 0x80; }
    const numNalus = reader.readU16BE();
    for (let j = 0; j < numNalus; j++) {
      reader.read(reader.readU16BE());
    }
  }
  return record;
};

// HEVC は hvc1 (VisualSampleEntry) の中の hvcC に、HEVCDecoderConfigurationRecord を入れる (ISO/IEC 14496-15)
// (パラメータセットを映像データの中にも入れられる hev1 もあるが、Apple のプレイヤーなどは hvc1 でないと再生できないことがある)
export const write_mp4_hevc_track_information = (track_id: number, timescale: number, hevcDecoderConfigurationRecord: Buffer): Buffer => {
  const sps = find_sps(hevcDecoderConfigurationRecord);
  const [width, height] = sps != null ? read_resolution(sps) : [0, 0];

  return make((vector) => {
    track(track_id, width, height, timescale, 'vide', vector, (vector) => {
      box('hvc1', vector, (vector) => {
        visualSampleEntry(width, height, vector, (vector) => {
          box('hvcC', vector, (vector) => {
            vector.write(complete_parameter_set_arrays(hevcDecoderConfigurationRecord));
          });
        });
      });
    });
  });
};

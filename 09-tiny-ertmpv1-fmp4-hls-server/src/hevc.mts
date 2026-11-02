import ByteReader from '../../01-tiny-rtmp-server/src/byte-reader.mts';
import EBSPBitReader from '../../06-tiny-http-fmp4-server/src/ebsp-bit-reader.mts';
import { box, make, track, visualSampleEntry } from '../../06-tiny-http-fmp4-server/src/fmp4.mts';

const VPS_NUT = 32;
const SPS_NUT = 33;
const PPS_NUT = 34;

const find_sps = (hevcDecoderConfigurationRecord: Buffer): Buffer | null => {
  const reader = new ByteReader(hevcDecoderConfigurationRecord);
  reader.read(22);
  const numOfArrays = reader.readU8();
  for (let i = 0; i < numOfArrays; i++) {
    const nal_unit_type = reader.readU8() & 0x3F;
    const numNalus = reader.readU16BE();
    for (let j = 0; j < numNalus; j++) {
      const nalu = reader.read(reader.readU16BE());
      if (nal_unit_type === SPS_NUT) { return nalu; }
    }
  }
  return null;
};

const read_resolution = (sps: Buffer): [width: number, height: number] => {
  const reader = new EBSPBitReader(sps.subarray(2));
  reader.skipBits(4);
  const sps_max_sub_layers_minus1 = reader.readBits(3);
  reader.skipBool();
  reader.skipBits(88);
  reader.skipBits(8);
  const sub_layers = Array.from({ length: sps_max_sub_layers_minus1 }, () => {
    return { profile_present: reader.readBool(), level_present: reader.readBool() };
  });
  if (sps_max_sub_layers_minus1 > 0) { reader.skipBits(2 * (8 - sps_max_sub_layers_minus1)); }
  for (const { profile_present, level_present } of sub_layers) {
    if (profile_present) { reader.skipBits(88); }
    if (level_present) { reader.skipBits(8); }
  }
  reader.skipUEG();
  const chroma_format_idc = reader.readUEG();
  if (chroma_format_idc === 3) { reader.skipBool(); }
  const pic_width_in_luma_samples = reader.readUEG();
  const pic_height_in_luma_samples = reader.readUEG();
  const conformance_window_flag = reader.readBool();
  if (!conformance_window_flag) { return [pic_width_in_luma_samples, pic_height_in_luma_samples]; }
  const SubWidthC = chroma_format_idc === 1 || chroma_format_idc === 2 ? 2 : 1;
  const SubHeightC = chroma_format_idc === 1 ? 2 : 1;
  const left = reader.readUEG();
  const right = reader.readUEG();
  const top = reader.readUEG();
  const bottom = reader.readUEG();
  return [pic_width_in_luma_samples - SubWidthC * (left + right), pic_height_in_luma_samples - SubHeightC * (top + bottom)];
};

const complete_parameter_set_arrays = (hevcDecoderConfigurationRecord: Buffer): Buffer => {
  const record = Buffer.from(hevcDecoderConfigurationRecord);
  const reader = new ByteReader(record);
  reader.read(22);
  const numOfArrays = reader.readU8();
  for (let i = 0; i < numOfArrays; i++) {
    const header = reader.read(1);
    const nal_unit_type = header[0] & 0x3F;
    const parameter_set = nal_unit_type === VPS_NUT || nal_unit_type === SPS_NUT || nal_unit_type === PPS_NUT;
    header[0] = (header[0] & 0x7F) | (parameter_set ? 0x80 : 0x00);
    const numNalus = reader.readU16BE();
    for (let j = 0; j < numNalus; j++) {
      reader.read(reader.readU16BE());
    }
  }
  return record;
};

export const read_nal_unit_length_size = (hevcDecoderConfigurationRecord: Buffer): number => {
  return (hevcDecoderConfigurationRecord.readUInt8(21) & 0b00000011) + 1;
};

export const strip_parameter_sets = (sizedNalus: Buffer, lengthSize: number): Buffer => {
  const reader = new ByteReader(sizedNalus);
  const nalus: Buffer[] = [];
  while (!reader.isEOF()) {
    const header = reader.read(lengthSize);
    const length = header.readUIntBE(0, lengthSize);
    if (length === 0) { continue; }
    const nalu = reader.read(length);
    const nal_unit_type = (nalu.readUInt8(0) >> 1) & 0x3F;
    if (nal_unit_type === VPS_NUT || nal_unit_type === SPS_NUT || nal_unit_type === PPS_NUT) { continue; }
    nalus.push(header, nalu);
  }
  return Buffer.concat(nalus);
};

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

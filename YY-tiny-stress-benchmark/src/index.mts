import BitBuilder from '../../03-tiny-http-ts-server/src/bit-builder.mts';

import generate_sps from './generate-sps.mts';
import generate_pps from './generate-pps.mts';
import generate_slice from './generate-slice.mts';
import colorbar, { ColorbarConfig } from './colorbar.mts';

// 30 FPS として
// * 64x36 で 0.8 Mbps
// * 96x54 で 1.8 Mbps
// * 128x72 で 3.3 Mbps
// * 192x108 で 7.5 Mbps
// * 224x126 で 10 Mbps
const config = ColorbarConfig.from(128, 1, 'cover');
const { width, height } = config;
const yuv = colorbar(config);

const nal_unit = (nal_unit_type: number, rbsp: Buffer): Buffer => {
  const writer = new BitBuilder();

  writer.writeBits(0, 1); // forbidden_zero_bit
  writer.writeBits(3, 2); // nal_ref_idc
  writer.writeBits(nal_unit_type, 5); // nal_unit_type

  return Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01]), writer.build(), rbsp]);
};

process.stdout.write(nal_unit(7 /* SPS */, generate_sps(width, height)));
process.stdout.write(nal_unit(8 /* PPS */, generate_pps()));
process.stdout.write(nal_unit(5 /* IDR */, generate_slice(yuv, width, height)));

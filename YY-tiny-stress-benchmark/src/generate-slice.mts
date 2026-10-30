import EBSPBitBuilder from './ebsp-bit-builder.mts';
import { u_pos, v_pos, y_pos } from './colorbar.mts';

const ref_pic_list_modification = (writer: EBSPBitBuilder): void => {
  // I スライスなので何も書かない
};

const dec_ref_pic_marking = (writer: EBSPBitBuilder): void => {
  writer.writeBool(false); // no_output_of_prior_pics_flag
  writer.writeBool(false); // long_term_reference_flag
};

const slice_header = (writer: EBSPBitBuilder): void => {
  writer.writeUEG(0); // first_mb_in_slice
  writer.writeUEG(7); // slice_type
  writer.writeUEG(0); // pic_parameter_set_id
  writer.writeBits(0, 4); // frame_num
  writer.writeUEG(0); // idr_pic_id
  ref_pic_list_modification(writer);
  dec_ref_pic_marking(writer);
  writer.writeSEG(0); // slice_qp_delta
};

const macroblock_layer = (y: Buffer, u: Buffer, v: Buffer, writer: EBSPBitBuilder): void => {
  writer.writeUEG(25); // mb_type (※ I_PCM = 25)
  writer.writeByteAlign(0); // pcm_alignment_zero_bit
  writer.writeBytes(y); // pcm_sample_luma
  writer.writeBytes(u); // pcm_sample_chroma (Cb)
  writer.writeBytes(v); // pcm_sample_chroma (Cr)
};

const slice_data = (yuv: Buffer, width: number, height: number, writer: EBSPBitBuilder): void => {
  const width_in_mbs = Math.ceil(width / 16);
  const height_in_mbs = Math.ceil(height / 16);
  for (let count = 0; count < width_in_mbs * height_in_mbs; count++) {
    const x_mb = count % width_in_mbs;
    const y_mb = Math.floor(count / width_in_mbs);
    // マクロブロック (輝度 16x16, 色差 8x8) の画素を、圧縮せずにそのまま (I_PCM で) 送る
    const y_data = Buffer.alloc(16 * 16);
    const u_data = Buffer.alloc(8 * 8);
    const v_data = Buffer.alloc(8 * 8);

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        y_data[y * 16 + x] = yuv[y_pos(x_mb * 16 + x, y_mb * 16 + y, width)];
      }
    }
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        u_data[y * 8 + x] = yuv[u_pos(x_mb * 8 + x, y_mb * 8 + y, width, height)];
        v_data[y * 8 + x] = yuv[v_pos(x_mb * 8 + x, y_mb * 8 + y, width, height)];
      }
    }

    macroblock_layer(y_data, u_data, v_data, writer);
  }
};

export default (yuv: Buffer, width: number, height: number): Buffer => {
  const writer = new EBSPBitBuilder();

  slice_header(writer);
  slice_data(yuv, width, height, writer);
  writer.writeRBSPTrailingBits();

  return writer.build();
};

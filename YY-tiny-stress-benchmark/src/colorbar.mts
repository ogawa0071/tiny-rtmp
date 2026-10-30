// I420 (YUV 4:2:0) の画像の中での、各平面 (Y, U, V) の画素の位置
export const y_pos = (x: number, y: number, width: number): number => {
  return y * width + x;
};

export const u_pos = (x: number, y: number, width: number, height: number): number => {
  return (height * width) + y * Math.floor(width / 2) + x;
};

export const v_pos = (x: number, y: number, width: number, height: number): number => {
  return (height * width) + Math.floor(height * width / 4) + y * Math.floor(width / 2) + x;
};

const brand = Symbol();
export type ColorbarConfig = {
  width: number;
  height: number;
  [brand]: never;
};
export const ColorbarConfig = {
  from(width: number, height: number, objectFit: 'cover' | 'contain' = 'contain'): ColorbarConfig {
    const x_magnification = (objectFit === 'cover' ? Math.ceil : Math.floor)(width / 32);
    const y_magnification = (objectFit === 'cover' ? Math.ceil : Math.floor)(height / 18);
    const magnification = (objectFit === 'cover' ? Math.max : Math.min)(x_magnification, y_magnification);
    width = 32 * magnification;
    height = 18 * magnification;

    return {
      width,
      height,
    } as ColorbarConfig;
  },
};

type YUV = readonly [y: number, u: number, v: number];
const GRAY: YUV = [104, 128, 128]; // 40% Gray
// 左から順に並べる 75% のカラーバー
const BARS: readonly YUV[] = [
  [180, 128, 128], // 75% White
  [168, 44, 136], // Yellow
  [145, 147, 44], // Cyan
  [133, 63, 53], // Green
  [63, 193, 204], // Magenta
  [51, 109, 212], // Red
  [28, 212, 120], // Blue
];

export default ({ width, height }: ColorbarConfig): Buffer => {
  const yuv = Buffer.alloc(Math.floor(width * height * 3 / 2));
  // 色差 (U, V) の 1 画素と、それに対応する輝度 (Y) の 2x2 画素を塗る
  const fill = (x: number, y: number, [Y, U, V]: YUV): void => {
    yuv[y_pos(x * 2 + 0, y * 2 + 0, width)] = Y;
    yuv[y_pos(x * 2 + 1, y * 2 + 0, width)] = Y;
    yuv[y_pos(x * 2 + 0, y * 2 + 1, width)] = Y;
    yuv[y_pos(x * 2 + 1, y * 2 + 1, width)] = Y;
    yuv[u_pos(x, y, width, height)] = U;
    yuv[v_pos(x, y, width, height)] = V;
  };

  const a = width;
  const d = Math.floor(a / 8);
  const chroma_width = Math.floor(width / 2);

  for (let y = 0; y < Math.floor(height / 2); y++) {
    // 左右の端は 40% Gray
    for (let i = 0; i < Math.floor(d / 2); i++) {
      fill(i, y, GRAY);
      fill(chroma_width - 1 - i, y, GRAY);
    }
    // その間を 7 色で塗り分ける
    for (let i = Math.floor(d / 2); i < chroma_width - Math.floor(d / 2); i++) {
      fill(i, y, BARS[Math.floor((i - Math.floor(d / 2)) * 14 / (a - 2 * d))]);
    }
  }

  return yuv;
};

import { AMF0Marker, ecma_arrays } from './amf0-reader.mts';
import ByteBuilder from './byte-builder.mts';

// Object の key などで使う、長さ 16bit の UTF-8 文字列 (型マーカーなし)
const utf8 = (dst: ByteBuilder, data: string): void => {
  const bytes = Buffer.from(data, 'utf-8');
  dst.writeU16BE(bytes.byteLength);
  dst.write(bytes);
};

const string = (dst: ByteBuilder, data: string): void => {
  const bytes = Buffer.from(data, 'utf-8');
  // 長さが 16bit に収まらない文字列は LongString (長さが 32bit) で書き込む
  if (bytes.byteLength < 2 ** 16) {
    dst.writeU8(AMF0Marker.String);
    dst.writeU16BE(bytes.byteLength);
  } else {
    dst.writeU8(AMF0Marker.LongString);
    dst.writeU32BE(bytes.byteLength);
  }
  dst.write(bytes);
};

const object = (dst: ByteBuilder, data: object): void => {
  const entries = Object.entries(data);
  // ECMA Array として読んだものは ECMA Array (要素数から始まる) として書き戻す
  if (ecma_arrays.has(data)) {
    dst.writeU8(AMF0Marker.ECMAArray);
    dst.writeU32BE(entries.length);
  } else {
    dst.writeU8(AMF0Marker.Object);
  }
  for (const [k, v] of entries) {
    utf8(dst, k);
    value(dst, v);
  }
  utf8(dst, ''); // 終端は空文字列の key と
  dst.writeU8(AMF0Marker.ObjectEnd); // ObjectEnd マーカー
};

const strict_array = (dst: ByteBuilder, data: unknown[]): void => {
  dst.writeU8(AMF0Marker.StrictArray);
  dst.writeU32BE(data.length);
  for (const datum of data) {
    value(dst, datum);
  }
};

const date = (dst: ByteBuilder, data: Date): void => {
  dst.writeU8(AMF0Marker.Date);
  dst.writeF64BE(data.getTime());
  dst.writeI16BE(0); // タイムゾーン (予約済みで 0)
};

const value = (dst: ByteBuilder, data: unknown): void => {
  if (data === null) { dst.writeU8(AMF0Marker.Null); return; }
  if (data === undefined) { dst.writeU8(AMF0Marker.Undefined); return; }
  if (Array.isArray(data)) { strict_array(dst, data); return; }
  if (data instanceof Date) { date(dst, data); return; }
  switch (typeof data) {
    case 'number':
      dst.writeU8(AMF0Marker.Number);
      dst.writeF64BE(data);
      return;
    case 'boolean':
      dst.writeU8(AMF0Marker.Boolean);
      dst.writeU8(data ? 1 : 0);
      return;
    case 'string':
      string(dst, data);
      return;
    case 'object':
      object(dst, data);
      return;
  }
  throw new Error('Invalid AMF0 Data');
};

export default (... data: unknown[]): Buffer => {
  const builder = new ByteBuilder();
  for (const datum of data) {
    value(builder, datum);
  }
  return builder.build();
};

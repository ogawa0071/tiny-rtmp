import { AMF0Marker, ecma_arrays } from './amf0-reader.mts';
import ByteBuilder from './byte-builder.mts';

const utf8 = (dst: ByteBuilder, data: string): void => {
  const bytes = Buffer.from(data, 'utf-8');
  dst.writeU16BE(bytes.byteLength);
  dst.write(bytes);
};

const string = (dst: ByteBuilder, data: string): void => {
  const bytes = Buffer.from(data, 'utf-8');
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
  utf8(dst, '');
  dst.writeU8(AMF0Marker.ObjectEnd); // ObjectEnd
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
  dst.writeI16BE(0);
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

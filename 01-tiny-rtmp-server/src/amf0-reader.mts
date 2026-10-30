import ByteReader from './byte-reader.mts';

// AMF0 の各値の先頭 1byte に置かれる型マーカー
export const AMF0Marker = {
  Number: 0x00,
  Boolean: 0x01,
  String: 0x02,
  Object: 0x03,
  MovieClip: 0x04, // 予約済みで使われない
  Null: 0x05,
  Undefined: 0x06,
  Reference: 0x07,
  ECMAArray: 0x08,
  ObjectEnd: 0x09,
  StrictArray: 0x0A,
  Date: 0x0B,
  LongString: 0x0C,
} as const;

const scriptend: unique symbol = Symbol();
export type AMF0Object = {
  [key: string]: AMF0Value;
};
export type AMF0Value = number | boolean | string | null | undefined | typeof scriptend | Date | AMF0Object | AMF0Value[];
export const isAMF0Null = (data: AMF0Value): data is null => {
  return data === null;
};
export const isAMF0Undefined = (data: AMF0Value): data is undefined => {
  return data === undefined;
};
export const isAMF0Nullish = (data: AMF0Value): data is null | undefined => {
  return data == null;
};
export const isAMF0Boolean = (data: AMF0Value): data is boolean => {
  return typeof data === 'boolean';
};
export const isAMF0Number = (data: AMF0Value): data is number => {
  return typeof data === 'number';
};
export const isAMF0String = (data: AMF0Value): data is string => {
  return typeof data === 'string';
};
export const isAMF0Array = (data: AMF0Value): data is AMF0Value[] => {
  return Array.isArray(data);
};
export const isAMF0Date = (data: AMF0Value): data is Date => {
  return data instanceof Date;
};
export const isAMF0Object = (data: AMF0Value): data is AMF0Object => {
  return typeof data === 'object' && data !== null && !(data instanceof Date) && !Array.isArray(data);
};

const string = (reader: ByteReader): string => {
  const length = reader.readU16BE();
  return reader.read(length).toString('utf-8');
};

const long_string = (reader: ByteReader): string => {
  const length = reader.readU32BE();
  return reader.read(length).toString('utf-8');
};

const object = (reader: ByteReader): AMF0Object => {
  // 外部からの入力値なので prototype に __proto__ で触れてしまう
  // Object.create(null) で prototype なしとする
  const object: AMF0Object = Object.create(null);
  // key と value の組が続き、空文字列の key と ObjectEnd で終わる
  while (true) {
    const key = string(reader);
    const val = value(reader);
    if (val === scriptend) { return object; }
    object[key] = val;
  }
};

const ecma_array = (reader: ByteReader): AMF0Object => {
  reader.readU32BE(); // 要素数 (ObjectEnd で終端が分かるので使わない)
  return object(reader);
};

const strict_array = (reader: ByteReader): AMF0Value[] => {
  const length = reader.readU32BE();
  return Array.from({ length }, () => value(reader));
};

const date = (reader: ByteReader): Date => {
  const timestamp = reader.readF64BE(); // UNIX 時間 (ミリ秒)
  reader.readI16BE(); // タイムゾーン (予約済みで 0 であるべき)
  return new Date(timestamp);
};

const value = (reader: ByteReader): AMF0Value => {
  const marker = reader.readU8();
  switch (marker) {
    case AMF0Marker.Number: return reader.readF64BE();
    case AMF0Marker.Boolean: return reader.readU8() !== 0;
    case AMF0Marker.String: return string(reader);
    case AMF0Marker.Object: return object(reader);
    case AMF0Marker.MovieClip: throw new Error('Unsupported Marker: 4 (movie clip)');
    case AMF0Marker.Null: return null;
    case AMF0Marker.Undefined: return undefined;
    case AMF0Marker.Reference: throw new Error('Unsupported Marker: 7 (reference)');
    case AMF0Marker.ECMAArray: return ecma_array(reader);
    case AMF0Marker.ObjectEnd: return scriptend;
    case AMF0Marker.StrictArray: return strict_array(reader);
    case AMF0Marker.Date: return date(reader);
    case AMF0Marker.LongString: return long_string(reader);
    default: throw new Error(`Invalid Marker: ${marker}`);
  }
};

export default (data: Buffer): AMF0Value[] => {
  const reader = new ByteReader(data);
  const result: AMF0Value[] = [];
  while (!reader.isEOF()) {
    result.push(value(reader));
  }
  return result;
};

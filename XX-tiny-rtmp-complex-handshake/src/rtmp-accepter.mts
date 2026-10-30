import crypto, { randomBytes } from 'node:crypto';
import type { Duplex, Writable } from 'node:stream';

import type AsyncByteReader from '../../01-tiny-rtmp-server/src/async-byte-reader.mts';
import type { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';
import handle_rtmp, { type Handshake } from '../../01-tiny-rtmp-server/src/rtmp-accepter.mts';

const simple_handshake_C1S1C2S2 = async (c1: Buffer, reader: AsyncByteReader, connection: Duplex): Promise<boolean> => {
  // simple handshake
  const c1_random = c1.subarray(8);
  const s1_random = randomBytes(1536 - 8);
  const s1 = Buffer.concat([Buffer.alloc(8), s1_random]);
  connection.write(s1); // write S1

  const s2 = Buffer.concat([Buffer.alloc(8), c1_random]);
  connection.write(s2); // write S2
  const c2 = await reader.read(1536); // read C2
  const c2_random_echo = c2.subarray(8);

  return s1_random.equals(c2_random_echo);
};

const clientKey = Buffer.from('Genuine Adobe Flash Player 001', 'ascii');
const serverKey = Buffer.from('Genuine Adobe Flash Media Server 001', 'ascii');
// S2/C2 の署名に使う鍵は、上記の鍵にこの 32 byte を付け足したものから作る
const keySuffix = Buffer.from('F0EEC24A8068BEE82E00D0D1029E7E576EEC5D2D29806FAB93B8E636CFEB31AE', 'hex');
const DIGEST_LENGTH = 32;

const hmac_sha256 = (key: Buffer, ... data: Buffer[]): Buffer => {
  const hmac = crypto.createHmac('sha256', key);
  for (const datum of data) { hmac.update(datum); }
  return hmac.digest();
};

// digest の位置は、ブロック (offset から始まる 764 byte) の先頭 4 byte の値の和から決まる
const digest_position = (packet: Buffer, offset: number): number => {
  const sum = packet.readUint8(offset + 8) + packet.readUint8(offset + 9) + packet.readUint8(offset + 10) + packet.readUint8(offset + 11);
  return offset + 12 + (sum % 728);
};

// digest 自身 (32 byte) を除いた C1/S1 全体の HMAC-SHA256
const calculate_digest = (packet: Buffer, position: number, key: Buffer): Buffer => {
  return hmac_sha256(key, packet.subarray(0, position), packet.subarray(position + DIGEST_LENGTH));
};

const handshake_C1S1C2S2 = async (reader: AsyncByteReader, connection: Duplex): Promise<boolean> => {
  const c1 = await reader.read(1536); // read C1

  for (const offset of [0, 764]) { // Scheme 0 / Scheme 1
    const c1_digest_position = digest_position(c1, offset);
    const c1_digest = c1.subarray(c1_digest_position, c1_digest_position + DIGEST_LENGTH);
    if (!calculate_digest(c1, c1_digest_position, clientKey).equals(c1_digest)) { continue; }

    // S1 には C1 と同じ Scheme で、サーバの鍵による digest を埋め込む
    const s1 = Buffer.concat([Buffer.alloc(8), randomBytes(1536 - 8)]);
    s1[4] = 3; // version: 3
    const s1_digest_position = digest_position(s1, offset);
    const s1_digest = calculate_digest(s1, s1_digest_position, serverKey);
    s1.set(s1_digest, s1_digest_position);
    connection.write(s1); // write S1

    // S2 の末尾 32 byte には、C1 の digest から作った鍵による署名を入れる
    const s2 = randomBytes(1536);
    const s2_key = hmac_sha256(Buffer.concat([serverKey, keySuffix]), c1_digest);
    s2.set(hmac_sha256(s2_key, s2.subarray(0, s2.byteLength - DIGEST_LENGTH)), s2.byteLength - DIGEST_LENGTH);
    connection.write(s2); // write S2

    // C2 の末尾 32 byte が、S1 の digest から作った鍵による署名になっているかを検証する
    const c2 = await reader.read(1536); // read C2
    const c2_key = hmac_sha256(Buffer.concat([clientKey, keySuffix]), s1_digest);
    const c2_digest = hmac_sha256(c2_key, c2.subarray(0, c2.byteLength - DIGEST_LENGTH));
    if (c2_digest.equals(c2.subarray(c2.byteLength - DIGEST_LENGTH))) {
      return true;
    }
    // 署名だけサポートしてない場合があるので、その場合はランダムエコーを検証する
    // FFmpeg の 内蔵 (librtmpではない方) の打ち上げでこのルートを通る (8.0.1 で確認)
    return s1.subarray(8).equals(c2.subarray(8));
  }

  // version: 0 (C1 の digest を検証できなければ Simple Handshake として扱う)
  return simple_handshake_C1S1C2S2(c1, reader, connection);
};

const handle_handshake: Handshake = async (reader, connection) => {
  // C0/S0
  await reader.readU8(); // Read C0
  connection.write(Buffer.from([0x03])); // Write S0 (Version: 3)
  // C1/S1, C2/S2
  return handshake_C1S1C2S2(reader, connection);
};

// ハンドシェイク以外は RTMP受信サーバ (01-tiny-rtmp-server) と同じ処理を使う
export default (connection: Duplex, auth: AuthConfiguration, open_output?: () => Writable): Promise<void> => {
  return handle_rtmp(connection, auth, open_output, handle_handshake);
};

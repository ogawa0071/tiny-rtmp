import { duplexPair } from 'node:stream';
import type { Duplex, Readable } from 'node:stream';
import AsyncByteReader from './async-byte-reader.mts';
import read_message from './message-reader.mts';
import { logger } from './logger.mts';
import { Message, MessageType } from './message.mts';

const message_name = (message: Message): string => {
  switch (message.message_type_id) {
    case MessageType.SetChunkSize: return 'Set Chunk Size Message';
    case MessageType.Abort: return 'Abort Message';
    case MessageType.Acknowledgement: return 'Acknowledgement Message';
    case MessageType.UserControl: return 'User Control Message';
    case MessageType.WindowAcknowledgementSize: return 'Window Acknowledgement Size Message';
    case MessageType.SetPeerBandwidth: return 'Set Peer Bandwidth Message';
    case MessageType.Audio: return 'Audio Message';
    case MessageType.Video: return 'Video Message';
    case MessageType.DataAMF3: return 'Data (AMF3) Message';
    case MessageType.SharedObjectAMF3: return 'Shared Object (AMF3) Message';
    case MessageType.CommandAMF3: return 'Command (AMF3) Message';
    case MessageType.DataAMF0: return 'Data (AMF0) Message';
    case MessageType.SharedObjectAMF0: return 'Shared Object (AMF0) Message';
    case MessageType.CommandAMF0: return 'Command (AMF0) Message';
    case MessageType.Aggregate: return 'Aggregate Message';
  }
};

// 片方向に流れるデータを横から読み取って、RTMP のメッセージとしてログに出す
const dump = async (stream: Readable, direction: string, handshake_prefix: 'C' | 'S'): Promise<void> => {
  const reader = new AsyncByteReader();
  stream.on('data', (chunk: Buffer) => { reader.feed(chunk); });
  stream.on('close', () => { reader.feedEOF(); });

  try {
    await reader.read(1);
    logger.debug(`${direction} ${handshake_prefix}0`);
    await reader.read(1536);
    logger.debug(`${direction} ${handshake_prefix}1`);
    await reader.read(1536);
    logger.debug(`${direction} ${handshake_prefix}2`);
    for await (const message of read_message(reader)) {
      logger.debug(`${direction} ${message_name(message)}`, message);
    }
  } catch {
    // 切断されると読み取りが EOF で中断されるが、それは正常な終了なので何もしない
  } finally {
    reader.feedEOF();
  }
};

export default (duplex: Duplex): Duplex => {
  // duplexPair は仮想的なソケットの両端を作る (片方に書いたものがもう片方から読める)
  // サーバの処理には proxy を渡し、relay と本物の接続 (duplex) の間でデータを中継する
  const [proxy, relay] = duplexPair();

  void dump(duplex, 'CLIENT -> SERVER', 'C');
  void dump(relay, 'SERVER -> CLIENT', 'S');

  duplex.pipe(relay);
  relay.pipe(duplex);
  // 本物の接続が閉じたら、サーバに渡した proxy も閉じてセッションを終わらせる (pipe は close を伝えない)
  duplex.on('close', () => { proxy.destroy(); });
  // 本物の接続のエラー (RST による ECONNRESET など) も proxy に伝える
  // (pipe は自分のリスナーを外してエラーを投げ直すので、誰も受け取らないとプロセスごと落ちる)
  duplex.on('error', (error) => { proxy.destroy(error); });

  return proxy;
};

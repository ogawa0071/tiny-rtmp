import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Duplex, Writable } from 'node:stream';
import { setInterval } from 'node:timers/promises';

import AsyncByteReader from './async-byte-reader.mts';
import read_message from './message-reader.mts';
import { MessageType, WindowAcknowledgementSize, SetPeerBandwidth, StreamBegin, Acknowledgement } from './message.mts';
import type { Message } from './message.mts';
import { isAMF0Number, isAMF0Object, isAMF0String } from './amf0-reader.mts';
import write_amf0 from './amf0-writer.mts';
import MessageWriter from './message-writer.mts';
import FLVWriter from './flv-writer.mts';
import { logger } from './logger.mts';
import { load, store, initialized } from './rtmp-session.mts';
import AckCounter from './ack-counter.mts';
import { AuthResult, collect_query, strip_query, type AuthConfiguration, type AuthResultWithDescription } from './auth.mts';

export type Handshake = (reader: AsyncByteReader, connection: Duplex) => Promise<boolean>;

export const handle_handshake: Handshake = async (reader, connection) => {
  // C0/S0
  await reader.readU8(); // Read C0
  connection.write(Buffer.from([0x03])); // Write S0 (Version: 3)
  // C1/S1
  const c1 = await reader.read(1536); // read C1
  const c1_random = c1.subarray(8);
  const s1_random = randomBytes(1536 - 8);
  const s1 = Buffer.concat([Buffer.alloc(8), s1_random]);
  connection.write(s1); // write S1
  // C2/S2 (S2 は C1 のエコー: time は C1 の time、time2 は C1 を読んだ時刻 (0 で省略)、random は C1 の random)
  const s2 = Buffer.concat([c1.subarray(0, 4), Buffer.alloc(4), c1_random]);
  connection.write(s2); // write S2
  const c2 = await reader.read(1536); // read C2
  const c2_random_echo = c2.subarray(8);
  // Check Random Echo
  return s1_random.equals(c2_random_echo);
};

export const STATE = {
  WAITING_CONNECT: 'WAITING_CONNECT',
  WAITING_CREATESTREAM: 'WAITING_CREATESTREAM',
  WAITING_PUBLISH: 'WAITING_PUBLISH',
  PUBLISHED: 'PUBLISHED',
  DISCONNECTED: 'DISCONNECTED',
} as const;
export type State = (typeof STATE)[keyof typeof STATE];

const PUBLISH_MESSAGE_STREAM = 1;
const WINDOW_ACKNOWLEDGE_SIZE = 2500000;
export const need_yield = (state: State, message: Message): boolean => {
  if (state !== STATE.PUBLISHED) { return false; }
  if (message.message_stream_id !== PUBLISH_MESSAGE_STREAM) { return false; }

  switch (message.message_type_id) {
    case MessageType.Audio:
    case MessageType.Video:
    case MessageType.DataAMF0:
      return true;
    default:
      return false;
  }
};
// 認証処理は同期・非同期のどちらでも書けて、例外も投げうるので Promise.try でまとめて扱う
const authenticate = (name: string, fn: () => AuthResultWithDescription | Promise<AuthResultWithDescription>): Promise<AuthResultWithDescription> => {
  return Promise.try(fn).catch((): AuthResultWithDescription => {
    // 認証で不測のエラーが起きた場合は切断する
    logger.error(`${name} Auth Failed`);
    return [AuthResult.DISCONNECT, null];
  });
};
type MaybePromise<T,> = T | Promise<T>;
type Transition = (message: Message, writer: MessageWriter, auth: AuthConfiguration) => MaybePromise<State>;
export const TRANSITION = {
  [STATE.WAITING_CONNECT]: async (message, writer, auth) => {
    if (message.message_stream_id !== 0) { return STATE.WAITING_CONNECT; }
    if (message.message_type_id !== MessageType.CommandAMF0) { return STATE.WAITING_CONNECT; }
    const command = message.data;

    const name = command[0];
    if (name !== 'connect') { return STATE.WAITING_CONNECT; }
    if (!isAMF0Number(command[1])) { return STATE.WAITING_CONNECT; }
    const transaction_id = command[1];
    if (!isAMF0Object(command[2])) { return STATE.WAITING_CONNECT; }
    const app = command[2]['app'];
    if (!isAMF0String(app)) { return STATE.WAITING_CONNECT; }

    const [authResult, description] = await authenticate('Connect', () => auth.connect(strip_query(app), collect_query(app)));
    const connectAccepted = authResult === AuthResult.OK;

    // Connect を伝達する前に WindowAcknowledgementSize, SetPeerBandwidth, StreamBegin を伝達する
    writer.write(WindowAcknowledgementSize.from({ ack_window_size: WINDOW_ACKNOWLEDGE_SIZE, timestamp: 0 }));
    writer.write(SetPeerBandwidth.from({ ack_window_size: WINDOW_ACKNOWLEDGE_SIZE, limit_type: 2, timestamp: 0 }));
    writer.write(StreamBegin.from({ message_stream_id: 0, timestamp: 0 }));

    const status = connectAccepted ? '_result' : '_error';
    const server = connectAccepted ? {
      fmsVer: 'FMS/3,5,7,7009',
      capabilities: 31,
      mode: 1,
    } : null;
    // Connect のレスポンスが level -> code の順じゃないと FMLE 3.2 は落ちてしまう
    const info = connectAccepted ? {
      level: 'status', // 正常系
      code: 'NetConnection.Connect.Success',
      description: description ?? 'Connection succeeded.',
      data: { version: '3,5,7,7009' },
      objectEncoding: 0, // 0 = AMF0, 3 = AMF3
    } : {
      level: 'error', // 異常系
      code: 'NetConnection.Connect.Rejected',
      description: description ?? 'Connection rejected.',
    };

    // connect のレスポンス
    writer.write({
      message_type_id: MessageType.CommandAMF0,
      message_stream_id: 0,
      timestamp: 0,
      data: [status, transaction_id, server, info],
    });

    if (connectAccepted) {
      store({ app: strip_query(app) });
    }
    const next = {
      [AuthResult.OK]: STATE.WAITING_CREATESTREAM,
      [AuthResult.RETRY]: STATE.WAITING_CONNECT,
      [AuthResult.DISCONNECT]: STATE.DISCONNECTED,
    } as const satisfies Record<AuthResult, State>;

    return next[authResult];
  },
  [STATE.WAITING_CREATESTREAM]: (message, writer) => {
    if (message.message_stream_id !== 0) { return STATE.WAITING_CREATESTREAM; }
    if (message.message_type_id !== MessageType.CommandAMF0) { return STATE.WAITING_CREATESTREAM; }
    const command = message.data;

    const name = command[0];
    if (name !== 'createStream') { return STATE.WAITING_CREATESTREAM; }
    if (!isAMF0Number(command[1])) { return STATE.WAITING_CREATESTREAM; }
    const transaction_id = command[1];

    // CreateStream で作った Message Stream ID を返却する
    writer.write({
      message_type_id: MessageType.CommandAMF0,
      message_stream_id: 0,
      timestamp: 0,
      data: ['_result', transaction_id, null, PUBLISH_MESSAGE_STREAM],
    });

    return STATE.WAITING_PUBLISH;
  },
  [STATE.WAITING_PUBLISH]: async (message, writer, auth) => {
    if (message.message_stream_id !== PUBLISH_MESSAGE_STREAM) { return STATE.WAITING_PUBLISH; }
    if (message.message_type_id !== MessageType.CommandAMF0) { return STATE.WAITING_PUBLISH; }
    const command = message.data;

    const name = command[0];
    if (name !== 'publish') { return STATE.WAITING_PUBLISH; }
    if (!isAMF0String(command[3])) { return STATE.WAITING_PUBLISH; }
    const stream = command[3];

    // WAITING_PUBLISH なら connect が成功しているので app は必ず存在する
    const [authResult, description] = await authenticate('Publish', () => auth.publish(load()!.app!, strip_query(stream), collect_query(stream)));
    const publishAccepted = authResult === AuthResult.OK;

    if (publishAccepted) {
      // 利用開始する Message Stream ID を Stream Begin で伝達する
      writer.write(StreamBegin.from({ message_stream_id: PUBLISH_MESSAGE_STREAM, timestamp: 0 }));
    }

    const info = publishAccepted ? {
      level: 'status', // 正常系
      code: 'NetStream.Publish.Start',
      description: description ?? 'Publish Accepted',
    } : {
      level: 'error', // 異常系
      code: 'NetStream.Publish.BadName', // 配信中や不正なストリーム名 (Flash の NetStatus のコードで、OBS (librtmp) や nginx-rtmp も使う)
      description: description ?? 'Publish Failed',
    };

    // Publish のレスポンスを onStatus で返す (onStatus の Transaction ID は 0 と決まっている)
    writer.write({
      message_type_id: MessageType.CommandAMF0,
      message_stream_id: message.message_stream_id,
      timestamp: 0,
      data: ['onStatus', 0, null, info],
    });

    if (publishAccepted) {
      store({ stream: strip_query(stream), query: collect_query(stream) });
    }

    const next = {
      [AuthResult.OK]: STATE.PUBLISHED,
      [AuthResult.RETRY]: STATE.WAITING_PUBLISH,
      [AuthResult.DISCONNECT]: STATE.DISCONNECTED,
    } as const satisfies Record<AuthResult, State>;

    return next[authResult];
  },
  [STATE.PUBLISHED]: (message) => {
    if (message.message_stream_id !== 0) { return STATE.PUBLISHED; }
    if (message.message_type_id !== MessageType.CommandAMF0) { return STATE.PUBLISHED; }
    const command = message.data;

    const name = command[0];
    if (name !== 'deleteStream') { return STATE.PUBLISHED; }
    const stream = command[3];
    if (stream !== PUBLISH_MESSAGE_STREAM) { return STATE.PUBLISHED; }

    return STATE.DISCONNECTED;
  },
  [STATE.DISCONNECTED]: () => {
    return STATE.DISCONNECTED;
  },
} satisfies Record<State, Transition>;

const KEEPALIVE_INTERVAL = 10 * 1000; // MEMO: アプリケーション変数

async function* handle_rtmp(connection: Duplex, auth: AuthConfiguration, handshake: Handshake): AsyncIterable<Message> {
  if (!initialized()) { throw new Error('RTMP session not initialized.'); }

  const controller = new AbortController();
  using writer = new MessageWriter({ signal: controller.signal });
  Readable.from(writer.retrieve()).pipe(connection);
  const counter = new AckCounter((bytes: number) => {
    try {
      // MEMO: システム系はあんま timestamp に意味ない? らしい...? ので 0 にしてる
      writer.write(Acknowledgement.from({ sequence_number: bytes, timestamp: 0 }));
    } catch {
      // 切断処理が始まった後に届いたデータには Acknowledgement を返せない (writer は例外を投げる)
      // ソケットの data イベントの中で例外を投げるとプロセスごと落ちるので、ここで握りつぶす
    }
  });
  using reader = new AsyncByteReader({ signal: controller.signal });
  connection.on('data', (data: Buffer) => {
    reader.feed(data);
    counter.feed(data.byteLength);
  });
  connection.on('close', () => { controller.abort(new Error('Connection closed')); });
  connection.on('error', (error) => { controller.abort(error); });

  try {
    /*
    * RTMPのハンドシェイクを処理する
    */
    if (!await handshake(reader, connection)) { return; }

    /*
    * RTMPのメッセージを処理する
    */
    let state: State = STATE.WAITING_CONNECT;

    // abort 時に強制的に切断状態に移行する
    if (controller.signal.aborted) { return; }
    controller.signal.addEventListener('abort', () => {
      state = STATE.DISCONNECTED;
    }, { once: true });
    // 配信セッションの定期的な生存確認
    const keepalive_controller = new AbortController();
    const keepalive = async (): Promise<void> => {
      const signal = AbortSignal.any([controller.signal, keepalive_controller.signal]);
      for await (const _ of setInterval(KEEPALIVE_INTERVAL, undefined, { signal })) {
        if (state !== STATE.PUBLISHED) { continue; }
        // PUBLISHED なら session 内であり app と stream は必ず存在する
        const session = load()!;
        const result = await Promise.try(() => auth.keepalive(session.app!, session.stream!, session.query)).catch(() => {
          // keepalive 自体が不測の事態で失敗した場合は可用性を優先して切断しない
          logger.error('Auth keepalive Failed');
          return AuthResult.OK;
        });
        if (result === AuthResult.DISCONNECT) {
          controller.abort(new Error('keepalive check failed'));
          return;
        }
      }
    };
    // 切断などで signal が abort されると setInterval は例外で終わるが、それは正常な終了なので無視する
    keepalive().catch(() => {});

    // メッセージループ
    try {
      for await (const message of read_message(reader)) {
        // 共通で処理するメッセージはここで処理する
        if (message.message_type_id === MessageType.WindowAcknowledgementSize) {
          counter.window(message.data.ack_window_size);
        }

        // 上位に伝える映像/音声/データのメッセージだったら伝える
        if (need_yield(state, message)) { yield message; }

        // 個別のメッセージによる状態遷移
        state = await TRANSITION[state](message, writer, auth);
        if (state === STATE.DISCONNECTED) { return; }
      }
    } finally {
      // ループが異常な理由で終了しても切断状態にする
      state = STATE.DISCONNECTED;
      keepalive_controller.abort();
    }
  } finally {
    writer.end();
    await writer.ended(); // 今の送信キューを flush して送信する
    connection.end();

    const session = load()!;
    if (session.app != null && session.stream != null) {
      await auth.disconnect(session.app, session.stream, session.query);
    }
  }
}

// 複数の配信が同時に同じ出力先へ書き込むと FLV が壊れるので、書き出すのは一度に一つの配信だけにする
let recording = false;

export default async (connection: Duplex, auth: AuthConfiguration, open_output?: () => Writable, handshake: Handshake = handle_handshake): Promise<void> => {
  // FLV の出力先は配信が始まってから開く (認証で切断されるような接続では開かない)
  // 書き出すかどうかは配信の最初のメッセージで決める (配信の途中から書き出すと、FLV の先頭に必要な初期化情報が欠ける)
  // undefined: まだ決めていない, null: この配信は書き出さない
  let writer: FLVWriter | null | undefined = undefined;
  // FLV のタグの timestamp は最初のタグを 0 とした時刻 (RTMP の timestamp は 0 から始まるとは限らない)
  let base: number | null = null;
  try {
    for await (const message of handle_rtmp(connection, auth, handshake)) {
      if (writer === undefined) {
        writer = open_output == null || recording ? null : new FLVWriter(open_output());
        recording ||= writer != null;
      }
      if (writer == null) { continue; }
      base ??= message.timestamp;
      // RTMP の timestamp は 32bit で一周するので、差も 2^32 で一周させて求める
      // 32bit の符号付き整数として負になる差 (最初のタグより前の時刻) は 0 に揃える
      const elapsed = (message.timestamp - base + 2 ** 32) % 2 ** 32;
      const timestamp = elapsed < 2 ** 31 ? elapsed : 0;

      switch (message.message_type_id) {
        case MessageType.Audio:
        case MessageType.Video:
          writer.write({ ... message, timestamp });
          break;
        case MessageType.DataAMF0: {
          // 配信ソフトは @setDataFrame 付きで onMetaData を送ってくるので、FLV には @setDataFrame を除いて書き込む
          const [name, ... values] = message.data;
          const data = write_amf0(... (name === '@setDataFrame' ? values : message.data));
          writer.write({ ... message, timestamp, data });
          break;
        }
      }
    }
  } finally {
    if (writer != null) {
      writer.close();
      recording = false;
    }
  }
};

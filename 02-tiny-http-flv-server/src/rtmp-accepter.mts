import { Readable } from 'node:stream';
import type { Duplex } from 'node:stream';
import { setTimeout } from 'node:timers';
import { setInterval } from 'node:timers/promises';

import AsyncByteReader from '../../01-tiny-rtmp-server/src/async-byte-reader.mts';
import read_message from '../../01-tiny-rtmp-server/src/message-reader.mts';
import AckCounter from '../../01-tiny-rtmp-server/src/ack-counter.mts';
import { AuthConfiguration, AuthResult } from '../../01-tiny-rtmp-server/src/auth.mts';
import { Acknowledgement, MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import type { Message } from '../../01-tiny-rtmp-server/src/message.mts';
import MessageWriter from '../../01-tiny-rtmp-server/src/message-writer.mts';
import { logger } from '../../01-tiny-rtmp-server/src/logger.mts';
import { load, initialized } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
// ハンドシェイクとメッセージによる状態遷移は RTMP受信サーバ (01-tiny-rtmp-server) と同じものを使う
import { STATE, TRANSITION, handle_handshake, need_yield, type State } from '../../01-tiny-rtmp-server/src/rtmp-accepter.mts';

import BandwidthEstimator from './bandwidth-estimator.mts';

export class DisconnectError extends Error {
  constructor(message: string, option?: ErrorOptions) {
    super(message, option);
    this.name = this.constructor.name;
  }
}

const KEEPALIVE_INTERVAL = 10 * 1000; // MEMO: アプリケーション変数
export type RTMPOption = {
  auth?: AuthConfiguration;
  limit?: {
    bandwidth?: number;
    highWaterMark?: number;
    timeout?: number;
  };
  interval?: {
    keepalive?: number;
  };
};

export default async function* handle_rtmp(connection: Duplex, option?: RTMPOption): AsyncIterable<Message> {
  if (!initialized()) { throw new Error('RTMP session not initialized.'); }

  const auth = option?.auth ?? AuthConfiguration.noAuth();
  const highWaterMark = option?.limit?.highWaterMark;
  const controller = new AbortController();
  using writer = new MessageWriter({ signal: controller.signal, highWaterMark });
  Readable.from(writer.retrieve()).pipe(connection);
  const counter = new AckCounter((bytes: number) => {
    writer.write(Acknowledgement.from({ sequence_number: bytes, timestamp: 0 }));
  });
  using reader = new AsyncByteReader({ signal: controller.signal, highWaterMark });
  // 帯域の制限を超えて送ってくる配信は切断する
  using estimator = new BandwidthEstimator(option?.limit?.bandwidth ?? Number.POSITIVE_INFINITY, controller);
  connection.on('data', (data: Buffer) => {
    reader.feed(data);
    counter.feed(data.byteLength);
    estimator.feed(data.byteLength);
  });
  const disconnected = () => { controller.abort(new DisconnectError('Disconnected!')); };
  connection.on('close', disconnected);
  connection.on('error', disconnected);
  // 映像/音声/データが一定時間届かない配信は切断する (届くたびに refresh で延長し、終了時に using で解除する)
  const timeout = option?.limit?.timeout;
  using idle_timer = timeout == null ? null : setTimeout(() => { controller.abort(new Error('Timeout Exceeded')); }, timeout);

  try {
    /*
    * RTMPのハンドシェイクを処理する
    */
    if (!await handle_handshake(reader, connection)) { return; }

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
      for await (const _ of setInterval(option?.interval?.keepalive ?? KEEPALIVE_INTERVAL, undefined, { signal })) {
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
      for await (const message of read_message(reader, { highWaterMark })) {
        // 共通で処理するメッセージはここで処理する
        if (message.message_type_id === MessageType.WindowAcknowledgementSize) {
          counter.window(message.data.ack_window_size);
        }

        // 上位に伝える映像/音声/データのメッセージだったら伝える
        if (need_yield(state, message)) {
          // 有効なメッセージなので無通信タイムアウトを延長
          idle_timer?.refresh();
          // 上位に伝達
          yield message;
        }

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

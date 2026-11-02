import { describe, expect, onTestFinished, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { congestion_checker } from '../src/congestion.mts';

// 視聴者のレスポンスの highWaterMark (index.mts の --highWaterMark)
const HIGH_WATER_MARK = 16384;

// highWaterMark を指定した HTTP サーバを空いているポートで立てて、リクエストが届いたらレスポンスを handler に渡す (テストが終わったら閉じる)
const serve = async (handler: (res: http.ServerResponse) => void): Promise<number> => {
  const server = http.createServer({ highWaterMark: HIGH_WATER_MARK }, (_, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    handler(res);
  });
  onTestFinished(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
};

// 視聴者としてレスポンスの本文を読み、受け取ったバイト数と、最後まで届いたか (切断されなかったか) を返す (delay ミリ秒たってから読み始める)
const view = async (port: number, delay = 0): Promise<{ bytes: number; complete: boolean; }> => {
  const [res] = await once(http.get({ host: '127.0.0.1', port }), 'response') as [http.IncomingMessage];
  res.pause();
  await sleep(delay);
  let bytes = 0;
  res.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; });
  res.on('error', () => {}); // 切断されると aborted のエラーになる
  const closed = once(res, 'close');
  res.resume();
  await closed;
  return { bytes, complete: res.complete };
};

describe('Cutting viewers whose sending is congested (--highWaterMark)', () => {
  test('a burst larger than highWaterMark written in one tick to a viewer that keeps reading is not cut', async () => {
    // index.mts と同じく for await で取り出しながら書く (同じ tick のマイクロタスクの中で書くので、tick の終わりまでは送られずに writableLength に数えられ、res.write も false を返す)
    const chunks = async function *(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 4; i++) { yield Buffer.alloc(32 * 1024); }
    };
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK);
      void (async () => {
        for await (const chunk of chunks()) {
          res.write(chunk);
          check_congestion();
        }
        setTimeout(() => res.end(), 100);
      })();
    });
    expect(await view(port)).toStrictEqual({ bytes: 4 * 32 * 1024, complete: true });
  });

  test('a viewer that stops reading is cut', async () => {
    let cut: boolean | null = null;
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK);
      // tick ごとに 64 KB ずつ書き続ける (視聴者が読まないと、カーネルの送受信バッファが一杯になって、送れずに残る)
      let written = 0;
      const write = (): void => {
        if (res.destroyed || written >= 64 * 1024 * 1024) { cut = res.destroyed; return; }
        res.write(Buffer.alloc(64 * 1024));
        check_congestion();
        written += 64 * 1024;
        setImmediate(write);
      };
      write();
    });
    // リクエストを送った後は、レスポンスを読まない
    const socket = net.connect(port, '127.0.0.1');
    onTestFinished(() => { socket.destroy(); });
    socket.pause();
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    while (cut == null) { await sleep(10); }
    expect(cut).toStrictEqual(true);
  });

  test('the data left unsent when the response ends is sent to the end', async () => {
    // 配信が終わった時: 視聴者がすぐには読まないので、カーネルの送受信バッファに入りきらずに残る 8 MB を書いて end する
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK);
      res.write(Buffer.alloc(8 * 1024 * 1024));
      check_congestion();
      res.end();
    });
    expect(await view(port, 100)).toStrictEqual({ bytes: 8 * 1024 * 1024, complete: true });
  });

  test('the bytes sent together when viewing starts, and as many bytes written while they are sent, are not counted as congestion', async () => {
    // 視聴を始めた時にまとめて送る 8 MB (視聴者がすぐには読まないので、カーネルの送受信バッファに入りきらずに残る)
    const initialBytes = 8 * 1024 * 1024;
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK, () => initialBytes);
      res.write(Buffer.alloc(initialBytes));
      check_congestion();
      // それを送り終わる前に、次の tick で 6 MB を書く (まとめて送った 8 MB を OS が全部受け取るまでは、それも合わせて writableLength に数えられる)
      setImmediate(() => {
        res.write(Buffer.alloc(6 * 1024 * 1024));
        check_congestion();
        setTimeout(() => res.end(), 300);
      });
    });
    expect(await view(port, 100)).toStrictEqual({ bytes: initialBytes + 6 * 1024 * 1024, complete: true });
  });

  test('a viewer that stops reading after the bytes sent together when viewing starts is cut once its backlog exceeds twice them', async () => {
    const initialBytes = 1024 * 1024;
    let cut: boolean | null = null;
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK, () => initialBytes);
      res.write(Buffer.alloc(initialBytes));
      check_congestion();
      // その後も tick ごとに 64 KB ずつ書き続ける (視聴者が読まないので、送れずに残る)
      let written = initialBytes;
      const write = (): void => {
        if (res.destroyed || written >= 64 * 1024 * 1024) { cut = res.destroyed; return; }
        res.write(Buffer.alloc(64 * 1024));
        check_congestion();
        written += 64 * 1024;
        setImmediate(write);
      };
      setImmediate(write);
    });
    // リクエストを送った後は、レスポンスを読まない
    const socket = net.connect(port, '127.0.0.1');
    onTestFinished(() => { socket.destroy(); });
    socket.pause();
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    while (cut == null) { await sleep(10); }
    expect(cut).toStrictEqual(true);
  });
});

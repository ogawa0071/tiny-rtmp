import { describe, expect, onTestFinished, test } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

import { congestion_checker } from '../src/congestion.mts';

const HIGH_WATER_MARK = 16384;

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

const view = async (port: number, delay = 0): Promise<{ bytes: number; complete: boolean; }> => {
  const [res] = await once(http.get({ host: '127.0.0.1', port }), 'response') as [http.IncomingMessage];
  res.pause();
  await sleep(delay);
  let bytes = 0;
  res.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; });
  res.on('error', () => {});
  const closed = once(res, 'close');
  res.resume();
  await closed;
  return { bytes, complete: res.complete };
};

describe('Cutting viewers whose sending is congested (--highWaterMark)', () => {
  test('a burst larger than highWaterMark written in one tick to a viewer that keeps reading is not cut', async () => {
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
    const socket = net.connect(port, '127.0.0.1');
    onTestFinished(() => { socket.destroy(); });
    socket.pause();
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    while (cut == null) { await sleep(10); }
    expect(cut).toStrictEqual(true);
  });

  test('the data left unsent when the response ends is sent to the end', async () => {
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK);
      res.write(Buffer.alloc(8 * 1024 * 1024));
      check_congestion();
      res.end();
    });
    expect(await view(port, 100)).toStrictEqual({ bytes: 8 * 1024 * 1024, complete: true });
  });

  test('the bytes sent together when viewing starts, and as many bytes written while they are sent, are not counted as congestion', async () => {
    const initialBytes = 8 * 1024 * 1024;
    const port = await serve((res) => {
      const check_congestion = congestion_checker(res, HIGH_WATER_MARK, () => initialBytes);
      res.write(Buffer.alloc(initialBytes));
      check_congestion();
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
    const socket = net.connect(port, '127.0.0.1');
    onTestFinished(() => { socket.destroy(); });
    socket.pause();
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    while (cut == null) { await sleep(10); }
    expect(cut).toStrictEqual(true);
  });
});

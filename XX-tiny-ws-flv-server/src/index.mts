import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import AsyncByteReader from '../../01-tiny-rtmp-server/src/async-byte-reader.mts';
import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import FLVRelay from '../../02-tiny-http-flv-server/src/flv-relay.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

const options = {
  rtmp: {
    type: 'string',
    default: '1935',
  },
  web: {
    type: 'string',
    default: '8000',
  },
  app: {
    type: 'string',
  },
  streamKey: {
    type: 'string',
  },
  bandwidth: {
    type: 'string',
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.rtmp, 10);
const web = Number.parseInt(args.web, 10);
const bandwidth = args.bandwidth != null ? Number.parseInt(args.bandwidth, 10) : undefined;
if (Number.isNaN(port) || Number.isNaN(web)) {
  console.error('Please Specify valid port number'); process.exit(1);
}
if (args.app == null) {
  console.error('Please Specify valid app'); process.exit(1);
}
if (args.streamKey == null) {
  console.error('Please Specify valid streamKey'); process.exit(1);
}
if (Number.isNaN(bandwidth)) {
  console.error('Please Specify valid bandwidth'); process.exit(1);
}
const app = args.app;
const streamKey = args.streamKey;
const auth = AuthConfiguration.simpleAuth(app, streamKey);
registerLogger(new ConsoleLogger());

type Viewer = {
  write: (buffer: Buffer) => void;
  exit: () => void;
  initialized: boolean;
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  const relay = new FLVRelay();
  let published = false;

  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;

      const relayed = relay.accept(message);
      if (relayed == null) { continue; }

      for (const viewer of viewers) {
        if (!viewer.initialized) {
          if (relay.hasVideoConfig() && !relayed.keyframe) { continue; }
          for (const initial of relay.initials()) { viewer.write(initial); }
          viewer.initialized = true;
          if (relayed.initial) { continue; }
        }
        viewer.write(relayed.tag);
      }
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    if (published) {
      for (const viewer of viewers) { viewer.exit(); }
    }
  }
};

const rtmp_server = net.createServer({ noDelay: true }, (connection) => {
  run(() => handle(connection));
});
rtmp_server.listen(port);

const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xA,
} as const;

const write_frame = (socket: Duplex, opcode: number, payload: Buffer): void => {
  socket.write(Buffer.from([0x80 | opcode])); // FIN + Opcode(Binary)
  if (payload.byteLength >= 2 ** 16) {
    const length = Buffer.alloc(1 + 8);
    length.writeUInt8(127, 0);
    length.writeBigUInt64BE(BigInt(payload.byteLength), 1);
    socket.write(length);
  } else if (payload.byteLength >= 126) {
    const length = Buffer.alloc(1 + 2);
    length.writeUInt8(126, 0);
    length.writeUInt16BE(payload.byteLength, 1);
    socket.write(length);
  } else {
    socket.write(Buffer.from([payload.byteLength]));
  }
  socket.write(payload);
};

const pingpong = async (reader: AsyncByteReader, socket: Duplex): Promise<void> => {
  while (true) {
    const first = await reader.readU8();
    const opcode = first & 0x0F;

    const second = await reader.readU8();
    if ((second & 0x80) === 0) {
      write_frame(socket, Opcode.Close, Buffer.from([0x03, 0xEA]));
      socket.end();
      return;
    }
    let length = second & 0x7F;
    if (length === 126) {
      length = await reader.readU16BE();
    } else if (length === 127) {
      const length64 = (await reader.read(8)).readBigUInt64BE(0);
      if (length64 > Number.MAX_SAFE_INTEGER) {
        socket.end();
        return;
      }
      length = Number(length64);
    }

    const maskingKey = await reader.read(4);
    const payload = await reader.read(length);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = payload[i] ^ maskingKey[i % 4];
    }

    switch (opcode) {
      case Opcode.Ping:
        write_frame(socket, Opcode.Pong, payload);
        break;
      case Opcode.Close:
        if (socket.writable) { write_frame(socket, Opcode.Close, payload.subarray(0, 2)); }
        socket.end();
        return;
    }
  }
};

const web_server = http.createServer();
web_server.addListener('upgrade', (req, socket, head) => {
  socket.on('error', () => { socket.destroy(); });
  const response = (status: number, message: string, headers?: Record<string, string>) => {
    const newline = '\r\n';
    socket.write(`HTTP/1.1 ${status} ${message}` + newline);
    for (const [key, value] of Object.entries(headers ?? {})) {
      socket.write(`${key}: ${value}` + newline);
    }
    socket.write(newline);
  };

  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  if (url == null || !(req.method === 'GET' && url.pathname === `/${app}/${streamKey}`)) {
    response(404, 'Not Found', { 'access-control-allow-origin': '*' });
    socket.end();
    return;
  }

  // Websocket
  const key = req.headers['sec-websocket-key'];
  if (req.headers['upgrade']?.toLowerCase() !== 'websocket' || key == null || Buffer.from(key, 'base64').byteLength !== 16) {
    response(400, 'Bad Request', { 'access-control-allow-origin': '*' });
    socket.end();
    return;
  }
  if (req.headers['sec-websocket-version'] !== '13') {
    response(426, 'Upgrade Required', { 'Sec-WebSocket-Version': '13', 'access-control-allow-origin': '*' });
    socket.end();
    return;
  }
  const accept = crypto.hash('sha1', key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'base64');
  // Send Switching Upgrade
  response(101, 'Switching Protocols', {
    'Upgrade': 'websocket',
    'Connection': 'Upgrade',
    'Sec-WebSocket-Accept': accept,
  });

  // recieve prepare
  const reader = new AsyncByteReader();
  reader.feed(head);
  socket.on('data', (chunk) => {
    reader.feed(chunk);
  });
  socket.on('close', () => {
    reader.feedEOF();
  });
  pingpong(reader, socket).catch(() => {}); // do ping pong

  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (socket.closed) { return; }
      write_frame(socket, Opcode.Binary, chunk);
    },
    exit: () => {
      if (socket.writable) { write_frame(socket, Opcode.Close, Buffer.from([0x03, 0xE8])); }
      socket.end();
      viewers.delete(viewer);
    },
    initialized: false,
  };
  viewers.add(viewer);

  req.on('close', viewer.exit);
  socket.on('close', viewer.exit);
  req.on('error', viewer.exit);
  socket.on('error', viewer.exit);
});
web_server.listen({ port: web });

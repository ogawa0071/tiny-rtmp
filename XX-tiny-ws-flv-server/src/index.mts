import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import AsyncByteReader from '../../01-tiny-rtmp-server/src/async-byte-reader.mts';
import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import write_amf0 from '../../01-tiny-rtmp-server/src/amf0-writer.mts';
import { isAMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
import { write_flv_header, write_flv_tag } from '../../01-tiny-rtmp-server/src/flv-writer.mts';
import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
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
  initialized: boolean; // FLV Header と、途中から視聴を始めた時に必要なメタデータとコーデックの初期化情報を送ったか
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  // 途中から視聴を始めた視聴者に最初に送る FLV Tag
  let onMetaData: Buffer | null = null;
  let avcConfig: Buffer | null = null;
  let aacConfig: Buffer | null = null;
  // FLV Header に書く、音声・映像があるかどうか (onMetaData が届くまでは両方あるとみなす)
  let has_audio = true;
  let has_video = true;
  let published = false;

  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;

      let tag: Buffer;
      let keyframe = false;
      switch (message.message_type_id) {
        case MessageType.Video: {
          if (message.data.byteLength < 2) { continue; }
          const [header, packetType] = message.data;
          // AVC (CodecID: 7) の映像のフレーム (FrameType: 1〜4) のみ受け付ける
          // (FrameType 5 は AVCPacketType を持たないコマンドで、先頭 1bit が立っていれば Enhanced RTMP の別の形式)
          const frameType = header >> 4;
          if ((header & 0x0F) !== 7 || frameType < 1 || frameType > 4) { continue; }
          tag = write_flv_tag(message);
          if (packetType === 0) { avcConfig = tag; } // AVC sequence header
          keyframe = frameType === 1 && packetType === 1; // キーフレームの AVC NALU
          break;
        }
        case MessageType.Audio: {
          if (message.data.byteLength < 2) { continue; }
          const [header, packetType] = message.data;
          if ((header >> 4) !== 10) { continue; } // AAC (SoundFormat: 10) のみ受け付ける
          tag = write_flv_tag(message);
          if (packetType === 0) { aacConfig = tag; } // AAC sequence header
          break;
        }
        case MessageType.DataAMF0: {
          // 配信ソフトは @setDataFrame 付きで送ってくるが、付いていない onMetaData もあるので、どちらも受け付ける
          const [name, metadata] = message.data[0] === '@setDataFrame' ? message.data.slice(1) : message.data;
          if (name !== 'onMetaData' || !isAMF0Object(metadata)) { continue; }
          // FLV には @setDataFrame を除いた onMetaData を書き込む
          tag = write_flv_tag({ ... message, data: write_amf0(name, metadata) });
          onMetaData = tag;
          has_audio = metadata.audiocodecid != null;
          has_video = metadata.videocodecid != null;
          break;
        }
        default: continue;
      }

      for (const viewer of viewers) {
        if (!viewer.initialized) {
          // 映像がある時はキーフレームから送り始める (それより前のフレームは、参照するフレームがないのでデコードできない)
          if (avcConfig != null && !keyframe) { continue; }
          viewer.write(write_flv_header(has_audio, has_video));
          for (const initial of [onMetaData, avcConfig, aacConfig]) {
            if (initial != null) { viewer.write(initial); }
          }
          viewer.initialized = true;
          // 初期化情報そのものだったら、もう送ったので送らない
          if (tag === onMetaData || tag === avcConfig || tag === aacConfig) { continue; }
        }
        viewer.write(tag);
      }
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    // 配信していた接続が終わったら視聴も終わらせる (認証に失敗した接続などでは何もしない)
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
  socket.write(Buffer.from([0x80 | opcode])); // FIN + Opcode
  // サーバから送るフレームはマスクしない (MASK: 0)
  // Payload Length は最小のバイト数で表す必要がある (126 未満で 64bit の長さなどを使うと受信できないことがある)
  if (payload.byteLength >= 2 ** 16) {
    const length = Buffer.alloc(1 + 8);
    length.writeUInt8(127, 0); // 続く 64bit が長さ
    length.writeBigUInt64BE(BigInt(payload.byteLength), 1);
    socket.write(length);
  } else if (payload.byteLength >= 126) {
    const length = Buffer.alloc(1 + 2);
    length.writeUInt8(126, 0); // 続く 16bit が長さ
    length.writeUInt16BE(payload.byteLength, 1);
    socket.write(length);
  } else {
    socket.write(Buffer.from([payload.byteLength]));
  }
  socket.write(payload);
};

// クライアントから届くフレームを読み、Ping には Pong を、Close には Close を返す
const pingpong = async (reader: AsyncByteReader, socket: Duplex): Promise<void> => {
  while (true) {
    const first = await reader.readU8(); // FIN (1bit), RSV1-3 (3bit), Opcode (4bit)
    const opcode = first & 0x0F;

    const second = await reader.readU8(); // MASK (1bit), Payload Length (7bit)
    // クライアントから届くフレームは必ずマスクされていて、されていなければ切断する (RFC 6455 5.1)
    if ((second & 0x80) === 0) {
      write_frame(socket, Opcode.Close, Buffer.from([0x03, 0xEA])); // 1002: Protocol Error
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

    // クライアントから届くフレームはマスクされているので、マスクを外す
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
        // Close を受け取ったら、同じステータスコードで Close を返して切断する
        write_frame(socket, Opcode.Close, payload.subarray(0, 2));
        socket.end();
        return;
    }
  }
};

const web_server = http.createServer();
web_server.addListener('upgrade', (req, socket, head) => {
  // upgrade 後のソケットのエラーは http サーバが処理しないので最初にリスナーを付ける (付けないと 404 を返した後の ECONNRESET などでプロセスごと落ちる)
  socket.on('error', () => { socket.destroy(); });
  const response = (status: number, message: string, headers?: Record<string, string>) => {
    const newline = '\r\n';
    socket.write(`HTTP/1.1 ${status} ${message}` + newline);
    for (const [key, value] of Object.entries(headers ?? {})) {
      socket.write(`${key}: ${value}` + newline);
    }
    socket.write(newline);
  };

  // new URL は解析できない URL (例: //[) だと例外を投げてサーバごと落ちるので、代わりに null を返す URL.parse を使う
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  if (url == null || !(req.method === 'GET' && url.pathname === `/${app}/${streamKey}`)) {
    response(404, 'Not Found', { 'access-control-allow-origin': '*' });
    socket.end();
    return;
  }

  // Websocket のハンドシェイク (RFC 6455 4.2.1)
  // Upgrade: websocket と、16 byte の乱数を base64 にした Sec-WebSocket-Key が必要
  const key = req.headers['sec-websocket-key'];
  if (req.headers['upgrade']?.toLowerCase() !== 'websocket' || key == null || Buffer.from(key, 'base64').byteLength !== 16) {
    response(400, 'Bad Request', { 'access-control-allow-origin': '*' });
    socket.end();
    return;
  }
  // 対応しているバージョン (13) 以外なら、対応しているバージョンを伝えて断る (RFC 6455 4.4)
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
  // FLV Header は、配信のメタデータが分かってから (視聴者の初期化時に) 送る

  // receive prepare
  const reader = new AsyncByteReader();
  reader.feed(head); // ハンドシェイクと一緒に届いていたフレームのデータ
  socket.on('data', (chunk) => {
    reader.feed(chunk);
  });
  socket.on('close', () => {
    reader.feedEOF();
  });
  // 切断されると読み取りが EOF で中断されるが、それは正常な終了なので無視する
  pingpong(reader, socket).catch(() => {});

  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (socket.closed) { return; }
      write_frame(socket, Opcode.Binary, chunk);
    },
    exit: () => {
      // こちらから切断する時は Close フレーム (1000: Normal Closure) を送ってから切断する (送らないと異常終了になる)
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

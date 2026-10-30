import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import write_amf0 from '../../01-tiny-rtmp-server/src/amf0-writer.mts';
import { write_flv_header, write_flv_tag } from '../../01-tiny-rtmp-server/src/flv-writer.mts';
import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import handle_rtmp from './rtmp-accepter.mts';

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
  highWaterMark: {
    type: 'string',
  },
  bandwidth: {
    type: 'string',
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.rtmp, 10);
const web = Number.parseInt(args.web, 10);
const highWaterMark = args.highWaterMark != null ? Number.parseInt(args.highWaterMark, 10) : undefined;
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
if (Number.isNaN(highWaterMark)) {
  console.error('Please Specify valid highwatermark'); process.exit(1);
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
  initialized: boolean; // 途中から視聴を始めた時に必要な、メタデータとコーデックの初期化情報を送ったか
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  // 途中から視聴を始めた視聴者に最初に送る FLV Tag
  let onMetaData: Buffer | null = null;
  let avcConfig: Buffer | null = null;
  let aacConfig: Buffer | null = null;
  let published = false;

  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;

      let tag: Buffer;
      switch (message.message_type_id) {
        case MessageType.Video: {
          const [header, packetType] = message.data;
          if ((header & 0x0F) !== 7) { continue; } // AVC (CodecID: 7) のみ受け付ける
          tag = write_flv_tag(message);
          if (packetType === 0) { avcConfig = tag; } // AVC sequence header
          break;
        }
        case MessageType.Audio: {
          const [header, packetType] = message.data;
          if ((header >> 4) !== 10) { continue; } // AAC (SoundFormat: 10) のみ受け付ける
          tag = write_flv_tag(message);
          if (packetType === 0) { aacConfig = tag; } // AAC sequence header
          break;
        }
        case MessageType.DataAMF0: {
          const [command, name, metadata] = message.data;
          if (command !== '@setDataFrame' || name !== 'onMetaData') { continue; }
          // FLV には @setDataFrame を除いた onMetaData を書き込む
          tag = write_flv_tag({ ... message, data: write_amf0(name, metadata) });
          onMetaData = tag;
          break;
        }
        default: continue;
      }

      for (const viewer of viewers) {
        if (!viewer.initialized) {
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

const web_server = http.createServer({ highWaterMark }, (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${web}`);
  if (!(req.method === 'GET' && url.pathname === `/${app}/${streamKey}`)) {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'access-control-allow-origin': '*',
  });
  res.write(write_flv_header(true, true));

  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (res.closed) { return; }
      // highWaterMark を超えて送信が詰まっている視聴者は切断する
      if (!res.write(chunk) && highWaterMark != null) { res.destroy(); }
    },
    exit: () => { res.end(); viewers.delete(viewer); },
    initialized: false,
  };
  viewers.add(viewer);

  req.on('close', viewer.exit);
  res.on('close', viewer.exit);
  req.on('error', viewer.exit);
  res.on('error', viewer.exit);
});
web_server.listen({ port: web });

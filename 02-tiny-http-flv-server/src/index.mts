import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { MessageType } from '../../01-tiny-rtmp-server/src/message.mts';
import write_amf0 from '../../01-tiny-rtmp-server/src/amf0-writer.mts';
import { isAMF0Object } from '../../01-tiny-rtmp-server/src/amf0-reader.mts';
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
  initialized: boolean; // FLV Header と、途中から視聴を始めた時に必要なメタデータとコーデックの初期化情報を送ったか
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  // 途中から視聴を始めた視聴者に最初に送る FLV Tag
  let onMetaData: Buffer | null = null;
  let avcConfig: Buffer | null = null;
  let aacConfig: Buffer | null = null;
  // FLV Header に書く、音声・映像を送るかどうか (onMetaData が届くまでは両方あるとみなす)
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
          // 中継するのは AAC (SoundFormat: 10) と AVC (CodecID: 7) だけなので、それ以外のコーデックなら送らないことを伝える
          // (コーデックを 'mp4a' や 'avc1' の文字列で書く配信ソフトもある)
          has_audio = metadata.audiocodecid === 10 || metadata.audiocodecid === 'mp4a';
          has_video = metadata.videocodecid === 7 || metadata.videocodecid === 'avc1';
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

const web_server = http.createServer({ highWaterMark }, (req, res) => {
  // new URL は解析できない URL (例: //[) だと例外を投げてサーバごと落ちるので、代わりに null を返す URL.parse を使う
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  if (url == null || !(req.method === 'GET' && url.pathname === `/${app}/${streamKey}`)) {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end();
    return;
  }
  // FLV Header は、配信のメタデータが分かってから (視聴者の初期化時に) 送るので、レスポンスヘッダだけ先に送る
  res.writeHead(200, {
    'content-type': 'video/x-flv',
    'access-control-allow-origin': '*',
  });
  res.flushHeaders();

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

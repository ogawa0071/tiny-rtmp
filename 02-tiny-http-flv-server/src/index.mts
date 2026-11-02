import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import handle_rtmp from './rtmp-accepter.mts';
import { congestion_checker } from './congestion.mts';
import FLVRelay from './flv-relay.mts';

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

const web_server = http.createServer({ highWaterMark }, (req, res) => {
  const url = URL.parse(req.url ?? '/', `http://localhost:${web}`);
  if (url == null || !(req.method === 'GET' && url.pathname === `/${app}/${streamKey}`)) {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'video/x-flv',
    'access-control-allow-origin': '*',
  });
  res.flushHeaders();

  const check_congestion = congestion_checker(res, highWaterMark);
  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (res.closed) { return; }
      res.write(chunk);
      check_congestion();
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

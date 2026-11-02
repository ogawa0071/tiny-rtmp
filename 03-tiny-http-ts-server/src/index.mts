import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import handle_rtmp from '../../02-tiny-http-flv-server/src/rtmp-accepter.mts';
import { congestion_checker } from '../../02-tiny-http-flv-server/src/congestion.mts';
import { AuthConfiguration } from '../../01-tiny-rtmp-server/src/auth.mts';

import MPEGTSTransmuxer from './mpegts-transmuxer.mts';
import DecisionWait from './decision-wait.mts';
import type { Output } from './decision-wait.mts';
import { TimestampUnwrapper } from './rtmp-handler.mts';

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
  initialBytes: number;
};
const viewers = new Set<Viewer>();

const handle = async (connection: Duplex) => {
  const rtmp_to_mpegts = new MPEGTSTransmuxer();
  const timestamps = new TimestampUnwrapper();
  let published = false;
  const wait = new DecisionWait(rtmp_to_mpegts);
  const send = ({ packets, released }: Output): void => {
    const data = Buffer.concat(packets);
    if (released) {
      for (const viewer of viewers) { viewer.initialBytes = data.byteLength; }
    }
    if (data.byteLength === 0) { return; }
    for (const viewer of viewers) { viewer.write(data); }
  };

  try {
    for await (const message of handle_rtmp(connection, { auth, limit: { bandwidth } })) {
      published = true;
      send(wait.feed(timestamps.unwrap(message)));
    }
  } catch (e) {
    logger.error('RTMP session error', { error: e });
  } finally {
    if (published) {
      send(wait.flush());
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
    'content-type': 'video/mp2t',
    'access-control-allow-origin': '*',
  });

  const check_congestion = congestion_checker(res, highWaterMark, () => viewer.initialBytes);
  const viewer: Viewer = {
    write: (chunk: Buffer) => {
      if (res.closed) { return; }
      res.write(chunk);
      check_congestion();
    },
    exit: () => { res.end(); viewers.delete(viewer); },
    initialBytes: 0,
  };
  viewers.add(viewer);

  req.on('close', viewer.exit);
  res.on('close', viewer.exit);
  req.on('error', viewer.exit);
  res.on('error', viewer.exit);
});
web_server.listen({ port: web });

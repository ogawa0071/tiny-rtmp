import net from 'node:net';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import handle_rtmp from '../../01-tiny-rtmp-server/src/rtmp-accepter.mts';
import intercepter from '../../01-tiny-rtmp-server/src/rtmp-intercepter.mts';
import { run } from '../../01-tiny-rtmp-server/src/rtmp-session.mts';
import { ConsoleLogger, LogLevel, logger, registerLogger } from '../../01-tiny-rtmp-server/src/logger.mts';

import AdobeAuth from './adobe-auth.mts';

const options = {
  port: {
    type: 'string',
    default: '1935',
  },
  user: {
    type: 'string',
  },
  password: {
    type: 'string',
  },
  flv: {
    type: 'string',
  },
  intercept: {
    type: 'boolean',
    default: false,
  },
} as const satisfies ParseArgsOptionsConfig;
const { values: args } = parseArgs({ options });
const port = Number.parseInt(args.port, 10);
if (Number.isNaN(port)) {
  console.error('Please Specify Valid PORT number');
  process.exit(1);
}
if (args.user == null) {
  console.error('Please Specify Valid user');
  process.exit(1);
}
if (args.password == null) {
  console.error('Please Specify Valid password');
  process.exit(1);
}
const user = args.user;
const password = args.password;
const flv = args.flv;
const intercept = args.intercept;
const auth = new AdobeAuth((userName) => user === userName ? password : null);
const open_flv = flv == null ? undefined : () => flv === '-' ? process.stdout : fs.createWriteStream(flv);
registerLogger(new ConsoleLogger(intercept ? LogLevel.DEBUG : LogLevel.INFO));

const server = net.createServer({ noDelay: true }, (connection) => {
  run(async () => {
    try {
      const proxy = intercept ? intercepter(connection) : connection;
      await handle_rtmp(proxy, auth, open_flv);
    } catch (e) {
      logger.error('RTMP session error', { error: e });
    }
  });
});
server.listen(port);

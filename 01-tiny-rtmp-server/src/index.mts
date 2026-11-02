import net from 'node:net';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';

import handle_rtmp from './rtmp-accepter.mts';
import { AuthConfiguration } from './auth.mts';
import intercepter from './rtmp-intercepter.mts';
import { run } from './rtmp-session.mts';
import { ConsoleLogger, LogLevel, logger, registerLogger } from './logger.mts';

const options = {
  port: {
    type: 'string',
    default: '1935',
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
const flv = args.flv;
const intercept = args.intercept;
const auth = AuthConfiguration.noAuth();
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

import type { ServerResponse } from 'node:http';

export const congestion_checker = (res: ServerResponse, highWaterMark: number | undefined, initialBytes: () => number = () => 0): () => void => {
  let checking = false;
  return () => {
    if (highWaterMark == null || checking) { return; }
    checking = true;
    setImmediate(() => {
      checking = false;
      if (!res.writableEnded && res.writableLength > highWaterMark + 2 * initialBytes()) { res.destroy(); }
    });
  };
};

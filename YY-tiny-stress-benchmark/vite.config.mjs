import { resolve } from 'node:path';
import { mergeConfig, defineConfig } from 'vite';

import pkg from './package.json' with { type: 'json' };
import commonConfig from '../vite.config.mjs';

export default mergeConfig(commonConfig, defineConfig({
  build: {
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.mts'),
      name: pkg.name,
      fileName: pkg.name,
      formats: ['es', 'cjs'],
    },
  },
}));

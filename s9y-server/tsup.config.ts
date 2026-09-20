import { defineConfig } from 'tsup';
import fs from 'node:fs';

export default defineConfig({
  // 入口文件
  entry: {
    'index': './index.ts',
  },

  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['@open-s9y/sdk', 'fastify', 'ws'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  shims: true,

  esbuildOptions(options) {
    // 保留中文，不转义 Unicode
    options.charset = 'utf8';
  },

  plugins: [{
    name: 'remove-empty-dirs',
    buildEnd() {
      for (const dir of ['dist/lib', 'dist/adapters']) {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  }],
});

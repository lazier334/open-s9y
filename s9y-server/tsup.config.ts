import { defineConfig } from 'tsup';

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
});

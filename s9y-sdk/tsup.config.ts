import { defineConfig } from 'tsup';

export default defineConfig({
  // 入口文件 - 只用一个统一入口
  entry: {
    'index': './src/index.ts',
  },

  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ['ws'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',

  esbuildOptions(options) {
    // 保留中文，不转义 Unicode
    options.charset = 'utf8';
  },
});

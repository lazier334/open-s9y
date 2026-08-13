import { defineConfig } from 'tsup';

export default defineConfig({
    // 入口文件
    entry: {
        'index': './src/s9y-type.ts',
        's9y-pivot-sdk': './src/s9y-pivot-sdk.ts',
        'http-pivot-sdk': './src/http-pivot-sdk.ts',
        'ws-pivot-sdk': './src/ws-pivot-sdk.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    // 不拆分代码（保持每个入口独立）
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['ws'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    esbuildOptions(options, context) {
        // 保留中文，不转义 Unicode 
        options.charset = 'utf8';

        // 只对 ESM 和 CJS 输出启用去注释（不压缩变量名）
        if (context.format === 'esm' || context.format === 'cjs') {
            // 移除空白和注释，不缩短变量名
            options.minifyWhitespace = true;
        }
    },

});

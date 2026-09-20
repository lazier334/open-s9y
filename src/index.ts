import type { GatewayServerOptions } from "@open-s9y/server";
import fs from "node:fs";
import path from "node:path";
import server from '@open-s9y/server';
import { pathToFileURL } from "node:url";

const pluginPath = path.join(import.meta.dirname, './plugins');
main({ funPivotDir: pluginPath });

async function main(options: GatewayServerOptions) {
    // 1. 初始化
    try {
        const initpath = path.join(pluginPath, 'lib/init.ts');
        if (fs.existsSync(initpath)) await import(pathToFileURL(initpath).href);
    } catch (err) {
        console.error('加载初始化模块失败:', err);
    }

    // 2. 检测文件存活状态(用于处理无法停止的情况)
    const runfile = 'start.log';
    fs.writeFileSync(runfile, new Date().toLocaleString());
    setInterval(() => {
        if (!fs.existsSync(runfile)) {
            console.warn('由于状态文件被删除, 正在退出服务器');
            process.exit(0);
        }
    }, 1000);

    // 3. 启动网关程序
    server(options);
}
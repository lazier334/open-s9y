import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GatewayServer } from "./server.ts";

main().catch((err) => {
    console.error("s9y启动失败:", err);
    process.exit(1);
});

async function main() {
    // 1. 初始化
    try {
        const initpath = path.join(import.meta.dirname, '../plugins/lib/init.ts');
        if (fs.existsSync(initpath)) await import(initpath);
    } catch (err) {
        console.error('加载初始化模块失败:', err);
    }

    // 2. 加载适配器
    await loadAdapters(new GatewayServer({
        port: process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 3000,
        heartbeatInterval: 30_000,
        pivotTimeout: 60_000,
        pluginPivotId: process.env.PLUGIN_PIVOT_ID ?? "router",
    }));

    // 3. [可选] 检测文件存活状态(用于避免无法停止)
    const runfile = 'start.log';
    fs.writeFileSync(runfile, new Date().toLocaleString());
    setInterval(() => {
        if (!fs.existsSync(runfile)) {
            console.warn('由于状态文件被删除, 正在退出服务器');
            process.exit(0);
        }
    }, 1000);
}

/** 加载适配器 */
async function loadAdapters(server: GatewayServer): Promise<void> {
    const adaptersDir = path.resolve(import.meta.dirname, "./adapters");
    const files = fs.readdirSync(adaptersDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
    for (const file of files) {
        const mod = await import(pathToFileURL(path.resolve(adaptersDir, file)).href) as Record<string, new (server: GatewayServer) => any>;
        Object.values(mod).filter(adapter => typeof adapter === "function" && adapter.name?.endsWith("Adapter") && adapter.name != 'S9yAdapter').forEach(adapter => {
            new adapter(server);
            console.info('已注册 Adapter:', adapter.name);
        });
    }
}

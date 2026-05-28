import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GatewayServer } from "./server.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

main().catch((err) => {
    console.error("启动网关失败:", err);
    process.exit(1);
});

async function main() {
    // 初始化
    try {
        const initpath = path.join(__dirname, '../plugins/lib/init.ts');
        if (fs.existsSync(initpath)) await import(initpath);
    } catch (err) {
        console.error('加载初始化模块失败:', err);
    }

    // 创建网关服务器对象
    const port = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 3000;
    const server = new GatewayServer({
        port,
        heartbeatInterval: 30_000,
        pivotTimeout: 60_000,
        pluginPivotId: process.env.PLUGIN_PIVOT_ID ?? "router-01",
    });

    // 加载适配器
    await loadAdapters(server);

    // 启动服务器
    const address = await server.listen(port);
    console.log(`网关服务正在监听: ${address}`);

    const shutdown = () => server.close().then(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

async function loadAdapters(server: GatewayServer): Promise<void> {
    const adaptersDir = path.resolve(__dirname, "./adapters");
    const files = fs.readdirSync(adaptersDir).filter(f => f.endsWith(".ts") || f.endsWith(".js"));
    for (const file of files) {
        const mod = await import(pathToFileURL(path.resolve(adaptersDir, file)).href) as Record<string, new (server: GatewayServer) => any>;
        Object.values(mod).filter(adapter => typeof adapter === "function" && adapter.name?.endsWith("Adapter")).forEach(adapter => {
            new adapter(server);
            console.log('已注册 Adapter:', adapter.name);
        });
    }
}

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GatewayServer, type GatewayServerOptions } from "./server.ts";

export default async function main(options: GatewayServerOptions) {
    try {
        // 加载适配器
        return await loadAdapters(new GatewayServer({
            port: process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 3000,
            heartbeatInterval: 30_000,
            pivotTimeout: 60_000,
            pluginPivotId: process.env.PLUGIN_PIVOT_ID ?? "router",
            funPivotDir: path.join(import.meta.dirname, '../plugins'),
            ...(typeof options != 'object' || options == null ? {} : options)
        }));
    } catch (err) {
        console.error("s9y启动失败:", err);
        process.exit(1);
    }
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

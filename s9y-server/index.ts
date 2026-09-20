import path from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayServer, type GatewayServerOptions } from "./server.ts";
export * from './adapters/s9y-adapter.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default server;
export async function server(options: GatewayServerOptions) {
    try {
        // 加载适配器
        const gateway = new GatewayServer({
            port: process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 10000,
            heartbeatInterval: 30_000,
            pivotTimeout: 60_000,
            pluginPivotId: process.env.PLUGIN_PIVOT_ID ?? "router",
            funPivotDir: path.join(__dirname, '../plugins'),
            ...(typeof options != 'object' || options == null ? {} : options)
        });
        [
            await import('./adapters/fun-adapter.ts'),
            await import('./adapters/http-adapter.ts'),
            await import('./adapters/ws-adapter.ts'),
        ].forEach((mod: object) => {
            // 拿到导出列表里以 Adapter 结尾的函数，然后惊进行注册
            Object.values(mod).filter(adapter => typeof adapter === "function" && adapter.name?.endsWith("Adapter") && adapter.name != 'S9yAdapter').forEach(adapterClass => {
                gateway.loadAdapter(adapterClass);
            });
        });

        return gateway;
    } catch (err) {
        console.error("s9y启动失败:", err);
        process.exit(1);
    }
}
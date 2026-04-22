import { GatewayServer } from "./core/server.ts";
import { RouterPivot } from "../plugins/router-pivot.ts";
import { GatewayProxyPivot } from "../plugins/gateway-proxy-pivot.ts";

/**
 * 网关服务入口函数
 * - 从环境变量读取端口，默认 3000
 * - 创建 RouterPivot 作为本地插件 pivot 并注册
 * - 注册 SIGINT/SIGTERM 信号处理器实现优雅关闭
 */
async function main() {
  const port = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 3000;
  const pluginPivotId = process.env.PLUGIN_PIVOT_ID ?? "router-01";

  const server = new GatewayServer({
    port,
    heartbeatInterval: 30_000,
    pivotTimeout: 60_000,
    pluginPivotId,
  });

  // 创建本地 RouterPivot 并注册
  const routerPivot = new RouterPivot({
    pivotId: pluginPivotId,
    type: "system",
    capabilities: { routing: true },
    gateway: server,
  });
  await routerPivot.connect();
  server.registerLocalPivot(pluginPivotId, routerPivot);
  console.log(`[Gateway] RouterPivot 已注册为本地 pivot: ${pluginPivotId}`);

  // 创建并注册网关代理 pivot（连接上游网关）
  const proxyCaps = GatewayProxyPivot.CONFIG
    .filter((c) => c.enabled)
    .reduce((acc, c) => ({ ...acc, ...c.capabilities }), {});

  const proxyPivot = new GatewayProxyPivot({
    pivotId: "gateway-proxy",
    capabilities: Object.keys(proxyCaps).length > 0 ? proxyCaps : { gatewayProxy: true },
  });
  await proxyPivot.connect();
  server.registerLocalPivot("gateway-proxy", proxyPivot);
  console.log("[Gateway] GatewayProxyPivot 已注册为本地 pivot");

  const address = await server.listen(port);
  console.log(`网关服务正在监听: ${address}`);

  const shutdown = async (signal: string) => {
    console.log(`\n接收到 ${signal}，正在关闭...`);
    proxyPivot.disconnect();
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("启动网关失败:", err);
  process.exit(1);
});

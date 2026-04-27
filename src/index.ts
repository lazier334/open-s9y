import { GatewayServer } from "./server.ts";

async function main() {
  const port = process.env.GATEWAY_PORT ? Number(process.env.GATEWAY_PORT) : 3000;

  const server = new GatewayServer({
    port,
    heartbeatInterval: 30_000,
    pivotTimeout: 60_000,
    pluginPivotId: process.env.PLUGIN_PIVOT_ID ?? "router-01",
  });

  const address = await server.listen(port);
  console.log(`网关服务正在监听: ${address}`);

  const shutdown = async (signal: string) => {
    console.log(`\n接收到 ${signal}，正在关闭...`);
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

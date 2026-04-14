import { GatewayServer } from "./core/server.ts";
import { SimpleRouterPlugin } from "../plugins/simple-router.ts";

/**
 * 网关服务入口函数
 * - 从环境变量读取端口，默认 3000
 * - 初始化 GatewayServer 并挂载 SimpleRouterPlugin
 * - 注册 SIGINT/SIGTERM 信号处理器实现优雅关闭
 */
async function main() {
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  const server = new GatewayServer({
    port,
    heartbeatInterval: 30_000,
    pivotTimeout: 60_000,
  });

  const plugin = new SimpleRouterPlugin();
  server.setPlugin(plugin);

  const address = await server.listen(port);
  console.log(`网关服务正在监听: ${address}`);

  /**
   * 优雅关闭处理器
   * @param signal - 接收到的进程信号名称（如 SIGINT、SIGTERM）
   */
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

/**
 * 伪网关客户端示例
 * - 作为 gateway 类型连接到上级网关
 * - 收到任务后打印并模拟透传到下级系统
 * - 可用于测试多级网关级联场景
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-gateway.ts
 */

import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

class FakeGateway extends BasePivot {
  private taskResults = new Map<string, unknown>();

  async onTask(message: Message): Promise<void> {
    const taskId = message.payload?.taskId as string | undefined;
    const data = message.payload?.data;

    console.log(`[FakeGateway] 收到上级网关任务 taskId=${taskId}`);
    console.log(`[FakeGateway] 原始数据:`, JSON.stringify(data, null, 2));
    console.log(`[FakeGateway] >>> 模拟透传到下级系统...`);

    // 立即记录结果
    this.taskResults.set(taskId ?? "unknown", {
      relayed: true,
      via: this.options.pivotId,
      message: "任务已通过伪网关透传",
    });

    console.log(`[FakeGateway] 任务已记录 taskId=${taskId}`);
  }

  onResultRequest(taskId: string): unknown {
    return this.taskResults.get(taskId) ?? { error: "Task not found" };
  }
}

async function main() {
  const gateway = new FakeGateway({
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000",
    pivotId: process.env.CLIENT_ID ?? "fake-gateway-01",
    type: "gateway",
    capabilities: { relay: true },
    priceTable: "gateway-standard",
  });

  await gateway.connect();
  console.log(`[FakeGateway] 已连接到上级网关，pivotId=${gateway.options.pivotId}`);

  process.on("SIGINT", () => {
    console.log("\n[FakeGateway] 断开连接");
    gateway.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FakeGateway] 启动失败:", err);
  process.exit(1);
});

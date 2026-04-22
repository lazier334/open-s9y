/**
 * 伪工具客户端示例（WebSocket 模式）
 * - 作为 tool 类型通过 WS 连接到网关
 * - 收到 push 后直接在 onTask 中返回结果，SDK 自动回传
 * - 支持计算数字相加
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-tool-ws.ts
 */

import { BasePivot } from "../src/client/base-pivot.ts";
import type { Message } from "../src/protocol/message.ts";

class FakeToolWs extends BasePivot {
  async onTask(message: Message): Promise<Record<string, unknown>> {
    const data = message.payload?.data as { content: string; numbers: unknown[] };

    console.log(`[FakeToolWs] 收到任务:`, JSON.stringify(data, null, 2));

    if (Array.isArray(data.numbers)) {
      let result = {
        data: 0,
        msg: [] as string[],
      };
      data.numbers.forEach((n) => {
        const num = Number(n);
        if (isNaN(num)) result.msg.push(`'${n}' 不是一个数字`);
        else result.data += num;
      });
      (data as Record<string, unknown>).result = result;
    }

    return {
      tool: "fake-tool-ws",
      executed: true,
      timestamp: new Date().toISOString(),
      input: data,
    };
  }
}

async function main() {
  const tool = new FakeToolWs({
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000",
    pivotId: process.env.CLIENT_ID ?? "fake-tool-ws-01",
    type: "tool",
    capabilities: { calc: true },
    useWebSocket: true,
  });

  await tool.connect();
  console.log(`[FakeToolWs] 已连接到网关，pivotId=${tool.options.pivotId}`);

  process.on("SIGINT", () => {
    console.log("\n[FakeToolWs] 断开连接");
    tool.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FakeToolWs] 启动失败:", err);
  process.exit(1);
});

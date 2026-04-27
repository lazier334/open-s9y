/**
 * 伪工具客户端示例（直接响应模式）
 * - 作为 tool 类型连接到网关
 * - 收到 push 后直接在 onTask 中返回结果，SDK 自动回传
 * - 无需 taskResults 缓存或 onResultRequest
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-tool.ts
 */

import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

class FakeTool extends BasePivot {
  async onTask(message: Message): Promise<Record<string, unknown>> {
    const data = message.payload?.data as { content: string, numbers: number[], result: object };

    console.log(`[FakeTool] 收到任务:`, JSON.stringify(data, null, 2));
    // 如果存在就做加法
    if (Array.isArray(data.numbers)) {
      let result = {
        data: 0,
        msg: [] as string[]
      };
      data.numbers.forEach(n => {
        let num = Number(n);
        if (isNaN(n)) result.msg.push(`'${n}' 不是一个数字`)
        else result.data += num
      });
      data.result = result;
    }

    return {
      tool: "fake-tool",
      executed: true,
      timestamp: new Date().toISOString(),
      input: data,
    };
  }
}

async function main() {
  const tool = new FakeTool({
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000",
    pivotId: process.env.CLIENT_ID ?? "fake-tool-01",
    type: "tool",
    capabilities: { calc: true },
    useWebSocket: false,
  });

  await tool.connect();
  console.log(`[FakeTool] 已连接到网关，pivotId=${tool.options.pivotId}`);

  process.on("SIGINT", () => {
    console.log("\n[FakeTool] 断开连接");
    tool.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FakeTool] 启动失败:", err);
  process.exit(1);
});

/**
 * 标准版用户客户端示例（使用 BasePivot）
 * - 类型为 user
 * - 通过 push() 向网关提交任务
 * - GET /pipe?taskId=...&protocol=progress 流式实时输出进度
 * - GET /pipe?taskId=...&protocol=result|status 挂起等待数据
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-user-pivot.ts "帮我写一首诗"
 */

import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

class FakeUserPivot extends BasePivot {
  async onTask(message: Message): Promise<void> {
    // 用户端通常不会被推送任务，这里仅做兜底打印
    console.log("[FakeUserPivot] 收到意外任务:", message);
  }
}

async function main() {
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";
  const content = process.argv[2] ?? "你好，世界";
  const taskId = `task-${Date.now()}`;
  const pivotId = `fake-user-${Date.now()}`;

  const user = new FakeUserPivot({
    gatewayUrl,
    pivotId,
    type: "user",
    capabilities: { input: true },
    priceTable: "user-standard",
    useWebSocket: true,
  });

  await user.connect();
  console.log(`[FakeUserPivot] 已连接到网关，pivotId=${pivotId}`);

  // 1. 提交任务
  const pushMsg: Message = {
    senderId: pivotId,
    type: "push",
    payload: {
      taskId,
      data: { content },
      capabilities: "chat",
      cost: "0.01",
    },
    traceId: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  await user.push(pushMsg);
  console.log(`[FakeUserPivot] 任务已提交: taskId=${taskId}`);

  // 2. 挂起读取进度（流式实时输出）
  console.log("[FakeUserPivot] --- 开始读取进度 ---");

  try {
    const stream = await user.progress(taskId);
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        try {
          const chunk = JSON.parse(text);
          console.log("[FakeUserPivot] 进度:", JSON.stringify(chunk, null, 2));
        } catch {
          console.log("[FakeUserPivot] 进度(raw):", text);
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    console.error("[FakeUserPivot] 读取进度失败:", err);
  }

  // 3. 挂起读取结果
  console.log("[FakeUserPivot] --- 开始读取结果 ---");

  try {
    const data = await user.result(taskId);
    console.log("[FakeUserPivot] 最终结果:", JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[FakeUserPivot] 读取结果失败:", err);
  }

  user.disconnect();
  process.exit(0);
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

main().catch((err) => {
  console.error("[FakeUserPivot] 异常:", err);
  process.exit(1);
});

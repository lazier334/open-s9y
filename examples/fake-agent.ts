/**
 * 伪 Agent 客户端示例
 * - 作为 agent 类型连接到网关
 * - 收到任务后按固定话术依次生成进度
 * - 通过 onProgressRequest 返回实时流，支持流式传输
 * - 通过 onResultRequest 响应 result 查询
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-agent.ts
 */

import { BasePivot } from "../src/client/base-pivot.ts";
import type { Message } from "../src/protocol/message.ts";

class FakeAgent extends BasePivot {
  private replies = [
    "收到，正在理解您的问题...",
    "正在检索相关知识库...",
    "正在生成回答，请稍候...",
    "这是最终答案：一切皆有可能。",
  ];

  private taskProgressWriters = new Map<string, WritableStreamDefaultWriter<unknown>>();
  private taskProgressStreams = new Map<string, ReadableStream<unknown>>();
  private taskResults = new Map<string, { answer: string; createdAt: number } | null>();

  async onTask(message: Message): Promise<void> {
    const taskId = message.payload?.taskId as string | undefined;
    const data = message.payload?.data;
    console.log(`[FakeAgent] 收到任务 taskId=${taskId}, data=`, data);

    if (!taskId) {
      console.error("[FakeAgent] 缺少 taskId，无法回复");
      return;
    }

    // 为本次任务创建 TransformStream，供 onProgressRequest 读取
    const ts = new TransformStream<unknown>();
    this.taskProgressStreams.set(taskId, ts.readable);
    this.taskProgressWriters.set(taskId, ts.writable.getWriter());
    this.taskResults.set(taskId, null);

    console.log(`[FakeAgent] 任务已记录 taskId=${taskId}`);

    this._generateProgress(taskId).catch((err) => {
      console.error(`[FakeAgent] 生成进度异常:`, err);
    });
  }

  private async _generateProgress(taskId: string) {
    const writer = this.taskProgressWriters.get(taskId);
    if (!writer) return;

    // === 直接发送原始数据，不再构造 4字节头+JSON 元数据帧 ===
    const progressLines = this.replies.slice(0, -1);

    for (let i = 0; i < progressLines.length; i++) {
      await delay(1000);
      const content = progressLines[i] + '\n';
      const bytes = new TextEncoder().encode(content);

      await writer.write(bytes);
      console.log(`[FakeAgent] 发送原始数据 ${bytes.length} bytes`);
    }

    await writer.close();

    this.taskProgressWriters.delete(taskId);
    this.taskProgressStreams.delete(taskId);
    this.taskResults.set(taskId, {
      answer: this.replies[this.replies.length - 1],
      createdAt: Date.now(),
    });
    console.log(`[FakeAgent] 任务完成 taskId=${taskId}`);
  }

  private async _generateProgress1(taskId: string) {
    const writer = this.taskProgressWriters.get(taskId);
    if (!writer) return;

    const progressLines = this.replies.slice(0, -1);

    for (let i = 0; i < progressLines.length; i++) {
      await delay(1000);
      const chunk = { step: i + 1, content: progressLines[i] };
      await writer.write(chunk);
      console.log(`[FakeAgent] 进度 step=${i + 1}: ${progressLines[i]}`);
    }

    await writer.close();
    this.taskProgressWriters.delete(taskId);
    this.taskProgressStreams.delete(taskId);

    this.taskResults.set(taskId, {
      answer: this.replies[this.replies.length - 1],
      createdAt: Date.now(),
    });
    console.log(`[FakeAgent] 任务完成 taskId=${taskId}`);
  }

  onProgressRequest(taskId: string): ReadableStream<unknown> | undefined {
    return this.taskProgressStreams.get(taskId);
  }

  onResultRequest(taskId: string): unknown {
    const result = this.taskResults.get(taskId);
    if (result === undefined) return { error: "Task not found" };
    if (result === null) return { status: "processing", message: "进度尚未完成" };
    return result;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const agent = new FakeAgent({
    gatewayUrl: process.env.GATEWAY_URL ?? "http://localhost:3000",
    pivotId: process.env.CLIENT_ID ?? "fake-agent-01",
    type: "agent",
    capabilities: { chat: true },
    priceTable: "agent-standard",
    useWebSocket: false,
  });

  await agent.connect();
  console.log(`[FakeAgent] 已连接到网关，pivotId=${agent.options.pivotId}`);

  process.on("SIGINT", () => {
    console.log("\n[FakeAgent] 断开连接");
    agent.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[FakeAgent] 启动失败:", err);
  process.exit(1);
});

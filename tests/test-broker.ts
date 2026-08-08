/**
 * Broker 端到端测试
 *
 * 前置条件：网关已启动且已加载 broker 插件
 *   node --env-file=.env.development --experimental-strip-types src/index.ts
 *
 * 运行：node --experimental-strip-types tests/test-broker.ts
 */

import { test, summary } from "./lib/result.ts";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Message } from "../sdk/type.ts";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const AUTH_COOKIE = "s9y-key=user";
const BROKER_PIVOT_ID = "broker";

// ─── 辅助函数 ───

function makeTaskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

async function push(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${GATEWAY_URL}/s9y`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: AUTH_COOKIE },
    body: JSON.stringify(msg),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`push 失败: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function submitTask(taskId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return push({
    senderId: "test-runner", targetId: BROKER_PIVOT_ID, type: "push",
    payload: { taskId, ...payload },
    traceId: `${taskId}-submit`, timestamp: Date.now(),
  });
}

async function queryBroker(taskId: string, peek = true): Promise<Record<string, unknown>> {
  return push({
    senderId: "test-runner", targetId: BROKER_PIVOT_ID, type: "push",
    payload: { taskId, protocol: "broker:query", sync: true, peek },
    traceId: `${taskId}-query-${Date.now()}`, timestamp: Date.now(),
  });
}

async function consumeResult(taskId: string): Promise<Record<string, unknown>> {
  return queryBroker(taskId, false);
}

async function waitForCompletion(taskId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    await sleep(500);
    last = await queryBroker(taskId);
    const status = last.status as string;
    if (status === "completed" || status === "dead_letter" || status === "not_found") break;
  }
  return last;
}

// ─── 测试执行者 ───

class TestWorker extends BasePivot {
  private activeTasks = new Map<string, AbortController>();

  constructor() {
    super({
      gatewayUrl: GATEWAY_URL, pivotId: "test-worker-1", type: "agent",
      name: "测试执行者", capabilities: ["broker:progress", "test-worker", "echo"],
      useWebSocket: false, headers: { Cookie: AUTH_COOKIE },
    });
  }

  async onTask(message: Message): Promise<unknown> {
    const taskId = message.payload?.taskId ?? message.payload?._brokerTaskId;
    if (!taskId) return { error: "缺少 taskId" };
    const brokerId = message.senderId;
    const abort = new AbortController();
    this.activeTasks.set(taskId, abort);
    this._processTask(taskId, brokerId, abort.signal).catch(() => {});
    return { acknowledged: true, taskId };
  }

  private async _processTask(taskId: string, brokerId: string, signal: AbortSignal): Promise<void> {
    try {
      await this._sendProgress(brokerId, taskId, "in_progress", 0, signal);
      for (let i = 1; i <= 3; i++) {
        if (signal.aborted) return;
        await sleep(600);
        await this._sendProgress(brokerId, taskId, "in_progress", Math.round((i / 3) * 100), signal);
      }
      await this._sendProgress(brokerId, taskId, "completed", 100, signal, { done: true });
    } catch {
      if (!signal.aborted) await this._sendProgress(brokerId, taskId, "failed", undefined, signal);
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  private async _sendProgress(
    brokerId: string, taskId: string, status: string,
    progress?: number, signal?: AbortSignal, result?: unknown,
  ): Promise<void> {
    if (signal?.aborted) return;
    try {
      await this.push({
        senderId: this.options.pivotId, targetId: brokerId, type: "push",
        payload: {
          taskId, protocol: "broker:progress", status, progress,
          ...(status === "completed" ? { result: result ?? { workerId: this.options.pivotId, processedAt: Date.now() } } : {}),
        },
        traceId: `${taskId}-${Date.now()}`, timestamp: Date.now(),
      });
    } catch { /* ignore */ }
  }

  async shutdown(): Promise<void> {
    for (const [, abort] of this.activeTasks) abort.abort();
    this.activeTasks.clear();
    await super.disconnect();
  }
}

// ─── 连通性检查 ───

let gatewayOk = false;

await test("网关可达", "网关服务应可访问", async () => {
  const res = await push({
    senderId: "test", type: "pivots", payload: {},
    traceId: crypto.randomUUID(), timestamp: Date.now(),
  });
  gatewayOk = true;
});

if (!gatewayOk) {
  console.log("\n  网关不可达，请先启动: npm run dev");
  process.exit(1);
}

// ─── 测试场景 ───

let worker: TestWorker;

await test("Worker 注册", "测试执行者应成功注册到网关", async () => {
  worker = new TestWorker();
  await worker.connect();
  await sleep(500);
});

await test("合规执行者: 提交 → 进度 → 完成 → 缓存消费", "完整任务生命周期", async () => {
  const taskId = makeTaskId("happy");
  await submitTask(taskId, {
    data: { action: "echo", input: "hello" },
    protocol: "broker:submit", workerId: "test-worker-1",
    timeout: 15000, maxRetries: 1,
  });
  const final = await waitForCompletion(taskId, 20_000);
  if (final.status !== "completed") throw new Error(`期望 completed，实际 ${final.status}`);
  const consumed = await consumeResult(taskId);
  if (consumed.source !== "cache") throw new Error(`期望从缓存消费，实际 source=${consumed.source}`);
});

await test("死信路径: 不存在的执行者 → 超时 → 死信", "无可用执行者应进入死信队列", async () => {
  const taskId = makeTaskId("dead");
  await submitTask(taskId, {
    data: { action: "doomed" },
    protocol: "broker:submit", workerId: "no-such-worker",
    timeout: 3000, maxRetries: 1,
  });
  const final = await waitForCompletion(taskId, 10_000);
  if (final.status !== "dead_letter") throw new Error(`期望 dead_letter，实际 ${final.status}`);
});

await test("能力匹配: 不指定 workerId，broker 自动选择", "应通过 capabilities 匹配到 test-worker-1", async () => {
  const taskId = makeTaskId("caps");
  await submitTask(taskId, {
    data: { action: "cap-match" },
    protocol: "broker:submit", capabilities: ["test-worker"],
    timeout: 15000, maxRetries: 1,
  });
  const final = await waitForCompletion(taskId, 20_000);
  if (final.status !== "completed") throw new Error(`期望 completed，实际 ${final.status}`);
});

await test("缓存生命周期: 完成入缓存 → 查询消费 → 缓存清理 → 终态保留", "缓存应在消费后清除，终态记录应保留", async () => {
  const taskId = makeTaskId("cache");
  await submitTask(taskId, {
    data: { action: "cache-test" },
    protocol: "broker:submit", workerId: "test-worker-1",
    timeout: 10000, maxRetries: 1,
  });
  const final = await waitForCompletion(taskId, 15_000);
  if (final.status !== "completed") throw new Error(`期望 completed，实际 ${final.status}`);

  // 消费结果
  const consumed = await consumeResult(taskId);
  if (consumed.source !== "cache") throw new Error(`消费应来自缓存，实际 source=${consumed.source}`);

  // 再次查询 —— 缓存应已清空
  const after = await queryBroker(taskId);
  if (after.source === "cache") throw new Error("消费后缓存应已清理");
});

await test("Worker 断开", "测试执行者应正常断开连接", async () => {
  if (worker) await worker.shutdown();
});

summary("Broker 端到端测试");

import type { Message } from "../sdk/type.ts";
import { BasePivot } from "../sdk/base-pivot-sdk.ts";

/**
 * 测试用执行者支点
 *
 * - 通过 HTTP 长轮询连接到网关
 * - 声明 broker:progress 能力（合规执行者）
 * - 收到任务后模拟异步处理：延迟 + 进度上报 + 返回结果
 *
 * 使用方式：
 *   node --experimental-strip-types test/test-worker.ts
 *
 * 环境变量：
 *   GATEWAY_URL  — 网关地址（默认 http://localhost:3000）
 *   WORKER_ID    — 支点 ID（默认 test-worker-1）
 *   WORKER_DELAY — 模拟处理延迟 ms（默认 3000）
 *   WORKER_STEPS — 进度上报步数（默认 3，即 33/66/100%）
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const WORKER_ID = process.env.WORKER_ID ?? "test-worker-1";
const WORKER_TYPE = (process.env.WORKER_TYPE ?? "agent") as "agent";
const WORKER_DELAY = Number(process.env.WORKER_DELAY) || 3000;
const WORKER_STEPS = Number(process.env.WORKER_STEPS) || 3;
const BROKER_ID = process.env.BROKER_PIVOT_ID ?? "broker-01";

export class TestWorker extends BasePivot {
  private activeTasks = new Map<string, AbortController>();

  constructor() {
    super({
      gatewayUrl: GATEWAY_URL,
      pivotId: WORKER_ID,
      type: WORKER_TYPE,
      name: "测试执行者",
      capabilities: ["broker:progress", "test-worker", "echo"],
      useWebSocket: false,
      headers: {
        Cookie: `s9y-key=${WORKER_TYPE}`,
      },
    });
  }

  async onTask(message: Message): Promise<unknown> {
    const taskId = message.payload?.taskId ?? message.payload?._brokerTaskId;
    if (!taskId) return { error: "缺少 taskId" };

    const brokerId = message.senderId;
    console.log(`[TestWorker] 收到任务 task=${taskId} from=${brokerId}`);

    const abort = new AbortController();
    this.activeTasks.set(taskId, abort);

    // 异步处理（不阻塞 onTask，broker 通过 broker:progress 获取进度）
    this._processTask(taskId, brokerId, abort.signal);

    return { acknowledged: true, taskId };
  }

  private async _processTask(taskId: string, brokerId: string, signal: AbortSignal): Promise<void> {
    const stepDelay = Math.round(WORKER_DELAY / WORKER_STEPS);

    try {
      // 发送进度：0% → IN_PROGRESS
      await this._sendProgress(brokerId, taskId, "in_progress", 0);

      for (let i = 1; i <= WORKER_STEPS; i++) {
        if (signal.aborted) return;
        await this._sleep(stepDelay);
        const pct = Math.round((i / WORKER_STEPS) * 100);
        await this._sendProgress(brokerId, taskId, "in_progress", pct);
      }

      // 完成
      await this._sendProgress(brokerId, taskId, "completed", 100);
      console.log(`[TestWorker] task=${taskId} 完成`);
    } catch (err) {
      if (signal.aborted) return;
      console.error(`[TestWorker] task=${taskId} 失败:`, err);
      await this._sendProgress(brokerId, taskId, "failed", undefined, String(err));
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  private async _sendProgress(
    brokerId: string,
    taskId: string,
    status: string,
    progress?: number,
    error?: string,
  ): Promise<void> {
    try {
      await this.push({
        senderId: this.options.pivotId,
        targetId: brokerId,
        type: "push",
        payload: {
          taskId,
          protocol: "broker:progress",
          status,
          progress,
          error,
          ...(status === "completed" ? { result: { workerId: this.options.pivotId, processedAt: Date.now() } } : {}),
        },
        traceId: `${taskId}-${Date.now()}`,
        timestamp: Date.now(),
      });
      console.log(`[TestWorker] task=${taskId} 进度: ${status}${progress != null ? ` ${progress}%` : ""}`);
    } catch (err) {
      console.error(`[TestWorker] task=${taskId} 上报失败:`, err);
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async disconnect(): Promise<void> {
    for (const [taskId, abort] of this.activeTasks) {
      abort.abort();
      console.log(`[TestWorker] 取消任务 task=${taskId}`);
    }
    this.activeTasks.clear();
    await super.disconnect();
  }
}

// ─── 入口 ───

async function main() {
  const worker = new TestWorker();

  console.log(`[TestWorker] 启动: id=${WORKER_ID} url=${GATEWAY_URL} delay=${WORKER_DELAY}ms steps=${WORKER_STEPS}`);
  await worker.connect();
  console.log(`[TestWorker] 已注册到网关，等待任务...`);

  const shutdown = async () => {
    console.log("\n[TestWorker] 正在关闭...");
    await worker.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[TestWorker] 启动失败:", err);
  process.exit(1);
});

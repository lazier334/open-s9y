/**
 * 原生 HTTP 长轮询实现的 other 类型客户端（最小可行性）
 * - 不依赖 BasePivot
 * - 使用 POST /register 长轮询等待消息
 * - 收到任务后异步处理，主循环立刻再次注册等待下一个指令
 * - 支持被外部查询：收到 pipe 消息后，通过 POST /pipe?taskId=...&protocol=xxx 回传数据
 *
 * 核心设计（适合 IoT 等极简设备）：
 *   1. 设备通过 /register 挂起请求，网关有消息时直接返回 Message JSON
 *   2. 设备收到任务后，本地异步处理，同时立刻再次发起 /register
 *   3. 任务处理过程中记录进度和结果，供后续查询使用
 *   4. 收到 pipe 查询时，通过 POST /pipe?taskId=...&protocol=xxx 将数据回传给网关
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-other-http.ts
 */

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";
const pivotId = process.env.CLIENT_ID ?? "fake-other-http-01";

// 任务进度与结果缓存（供查询使用）
const taskProgress = new Map<string, unknown[]>();
const taskResults = new Map<string, unknown>();

let hasRegisteredBefore = false;

async function registerAndWait(): Promise<Record<string, unknown>> {
  const body = hasRegisteredBefore
    ? { pivotId }
    : { pivotId, type: "other", capabilities: { iot: true }, priceTable: "iot-basic" };

  const res = await fetch(`${gatewayUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    throw new Error("注册冲突: pivotId 已被占用");
  }

  if (!res.ok) {
    throw new Error(`注册失败: ${res.status} ${await res.text()}`);
  }

  hasRegisteredBefore = true;
  return (await res.json()) as Record<string, unknown>;
}

async function postPipe(protocol: string, taskId: string, data: unknown, error?: string) {
  const res = await fetch(`${gatewayUrl}/pipe?taskId=${taskId}&protocol=${protocol}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(error ? { error } : { data }),
  });

  if (!res.ok) {
    console.error(`[OtherHTTP] POST /pipe?taskId=${taskId}&protocol=${protocol} 失败:`, await res.text());
  } else {
    console.log(`[OtherHTTP] POST /pipe?taskId=${taskId}&protocol=${protocol} 成功`);
  }
}

async function handlePipe(message: Record<string, unknown>) {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const taskId = payload.taskId as string | undefined;
  const protocol = payload.protocol as string | undefined;

  console.log(`[OtherHTTP] 收到 pipe 查询: protocol=${protocol}, taskId=${taskId}`);

  if (protocol === "progress") {
    const progresses = taskProgress.get(taskId ?? "") ?? [];
    await postPipe("progress", taskId ?? "", progresses);
    return;
  }

  if (protocol === "result") {
    const result = taskResults.get(taskId ?? "");
    await postPipe("result", taskId ?? "", result ?? { error: "Task not found" });
    return;
  }

  if (protocol === "status") {
    const result = taskResults.get(taskId ?? "");
    await postPipe("status", taskId ?? "", result ? { status: "completed" } : { status: "processing" });
    return;
  }

  console.log(`[OtherHTTP] 未知 pipe 协议: ${protocol}`);
}

async function handleTask(message: Record<string, unknown>) {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const taskId = payload.taskId as string | undefined;
  const data = payload.data;

  console.log(`[OtherHTTP] 开始处理任务 taskId=${taskId}`);
  console.log(`[OtherHTTP] 任务数据:`, JSON.stringify(data, null, 2));

  // 初始化进度缓存
  const progresses: unknown[] = [];
  taskProgress.set(taskId ?? "", progresses);

  // 模拟步骤 1
  await delay(800);
  progresses.push({ step: 1, content: "任务已接收，开始执行" });

  // 模拟步骤 2
  await delay(1000);
  progresses.push({ step: 2, content: "正在处理数据..." });

  // 模拟步骤 3
  await delay(1000);
  progresses.push({ step: 3, content: "处理完成" });

  const result = {
    processedBy: pivotId,
    timestamp: new Date().toISOString(),
    input: data,
    summary: `任务 ${taskId} 处理完成`,
  };

  taskResults.set(taskId ?? "", result);

  console.log(`[OtherHTTP] 任务处理完成 taskId=${taskId}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`[OtherHTTP] 启动，pivotId=${pivotId}`);

  while (true) {
    try {
      const msg = await registerAndWait();
      const type = (msg.type as string) ?? "noop";

      if (type === "noop") {
        console.log("[OtherHTTP] 长轮询超时，继续等待...");
        continue;
      }

      if (type === "push") {
        console.log("[OtherHTTP] 收到任务:", JSON.stringify(msg, null, 2));
        // 异步处理，不阻塞主循环，立刻再次注册等待下一个指令
        handleTask(msg).catch((err) => {
          console.error("[OtherHTTP] 任务处理异常:", err);
        });
        continue;
      }

      if (type === "pipe") {
        console.log("[OtherHTTP] 收到 pipe 查询:", JSON.stringify(msg, null, 2));
        // 异步处理查询，不阻塞主循环
        handlePipe(msg).catch((err) => {
          console.error("[OtherHTTP] 查询处理异常:", err);
        });
        continue;
      }
    } catch (err) {
      console.error("[OtherHTTP] 轮询异常:", err);
      hasRegisteredBefore = false;
      await delay(5000);
    }
  }
}

process.on("SIGINT", () => {
  console.log("\n[OtherHTTP] 退出");
  process.exit(0);
});

main().catch((err) => {
  console.error("[OtherHTTP] 启动失败:", err);
  process.exit(1);
});

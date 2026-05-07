/**
 * Broker 端到端测试脚本
 *
 * 用法:
 *   # 先启动网关和测试执行者（各一个终端）
 *   API_ADMIN=true node --experimental-strip-types src/index.ts
 *   node --experimental-strip-types test/test-worker.ts
 *
 *   # 运行全部场景
 *   node --experimental-strip-types test/runner.ts
 *
 *   # 只跑一个场景
 *   node --experimental-strip-types test/runner.ts happy
 *   node --experimental-strip-types test/runner.ts dead
 *   node --experimental-strip-types test/runner.ts caps
 *   node --experimental-strip-types test/runner.ts cache
 *   node --experimental-strip-types test/runner.ts result
 *   node --experimental-strip-types test/runner.ts get
 *
 * 场景说明:
 *   happy — 合规执行者完整流程（进度 0/33/67/100% → 完成 → 消费缓存）
 *   dead  — 不存在的执行者 → 超时 → 重试耗尽 → 死信
 *   caps  — 不指定 workerId，只给 capabilities，让 broker 自动匹配
 *   cache — 验证缓存：完成后同时在缓存+终态 → 查询消费 → 缓存消失、终态保留
 *   result — 拿结果：peek轮询 → 确认缓存存在 → 消费后缓存清理
 *   get    — 只拿结果：提交后 peek 等待 → 一步消费缓存取走结果
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const BROKER_ID = process.env.BROKER_PIVOT_ID ?? "broker-01";
const AUTH_COOKIE = `s9y-key=user`;

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(tag: string, msg: string): void {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}

async function push(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${GATEWAY_URL}/push`, {
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

function makeTaskId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

interface TaskResult {
  taskId: string;
  description: string;
  success: boolean;
  status: string;
  timeline?: Array<Record<string, unknown>>;
  result?: unknown;
  error?: string;
  duration: number;
  fromCache?: boolean;
}

async function submitTask(taskId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return push({
    senderId: "test-runner",
    targetId: BROKER_ID,
    type: "push",
    payload: { taskId, ...payload },
    traceId: `${taskId}-submit`,
    timestamp: Date.now(),
  });
}

async function queryBroker(taskId: string, peek = true): Promise<Record<string, unknown>> {
  return push({
    senderId: "test-runner",
    targetId: BROKER_ID,
    type: "push",
    payload: { taskId, protocol: "broker:query", sync: true, peek },
    traceId: `${taskId}-query-${Date.now()}`,
    timestamp: Date.now(),
  });
}

/** 查询并消费缓存结果 */
async function consumeResult(taskId: string): Promise<Record<string, unknown>> {
  return queryBroker(taskId, false);
}

/** 轮询直到任务进入终态或超时（peek 模式，不消费缓存） */
async function waitForCompletion(taskId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    await sleep(500);
    last = await queryBroker(taskId);
    const status = last.status as string;
    if (status === "completed" || status === "dead_letter" || status === "not_found") break;
    const progress = last.progress != null ? ` (${last.progress}%)` : "";
    log("POLL", `status=${status}${progress}`);
  }
  return last;
}

// ─── 测试场景 ───

async function testHappy(): Promise<TaskResult> {
  const taskId = makeTaskId("test-happy");
  const desc = "合规执行者（进度上报 + 完成 + 缓存）";
  log("RUN", `${desc} [${taskId}]`);
  const start = Date.now();

  await submitTask(taskId, {
    data: { action: "echo", input: "hello" },
    protocol: "broker:submit",
    workerId: "test-worker-1",
    timeout: 15000,
    maxRetries: 1,
  });

  const final = await waitForCompletion(taskId, 20_000);
  const duration = Date.now() - start;
  const success = final.status === "completed";
  log(success ? "PASS" : "FAIL", `status=${final.status} duration=${duration}ms`);

  const result: TaskResult = {
    taskId,
    description: desc,
    success,
    status: final.status as string,
    timeline: final.timeline as Array<Record<string, unknown>>,
    result: final.result,
    duration,
  };

  // 消费缓存结果
  const consumed = await consumeResult(taskId);
  if (consumed.source === "cache") {
    result.fromCache = true;
    log("CACHE", "✅ 从缓存消费结果");
  }
  // 再次查询：缓存已清空，回退到 tasks
  const after = await queryBroker(taskId);
  log(after.source === "tasks" ? "CACHE" : "CACHE",
    `消费后查询: source=${after.source ?? "tasks"} (预期 tasks)`);
  return result;
}

async function testDead(): Promise<TaskResult> {
  const taskId = makeTaskId("test-dead");
  const desc = "不存在的执行者 → 死信";
  log("RUN", `${desc} [${taskId}]`);
  const start = Date.now();

  await submitTask(taskId, {
    data: { action: "doomed" },
    protocol: "broker:submit",
    workerId: "no-such-worker",
    timeout: 3000,
    maxRetries: 1,
  });

  const final = await waitForCompletion(taskId, 10_000);
  const duration = Date.now() - start;
  const success = final.status === "dead_letter";
  log(success ? "PASS" : "FAIL", `status=${final.status} duration=${duration}ms`);

  return {
    taskId,
    description: desc,
    success,
    status: final.status as string,
    timeline: final.timeline as Array<Record<string, unknown>>,
    error: final.error as string,
    duration,
  };
}

async function testCaps(): Promise<TaskResult> {
  const taskId = makeTaskId("test-caps");
  const desc = "能力匹配（test-worker capability）";
  log("RUN", `${desc} [${taskId}]`);
  const start = Date.now();

  await submitTask(taskId, {
    data: { action: "capability-match" },
    protocol: "broker:submit",
    capabilities: ["test-worker"],
    timeout: 15000,
    maxRetries: 1,
  });

  const final = await waitForCompletion(taskId, 20_000);
  const duration = Date.now() - start;
  const success = final.status === "completed";
  log(success ? "PASS" : "FAIL", `status=${final.status} duration=${duration}ms`);

  return {
    taskId,
    description: desc,
    success,
    status: final.status as string,
    timeline: final.timeline as Array<Record<string, unknown>>,
    result: final.result,
    duration,
  };
}

async function testCache(): Promise<TaskResult> {
  const taskId = makeTaskId("test-cache");
  const desc = "缓存：完成即入缓存、查询后消费掉";
  log("RUN", `${desc} [${taskId}]`);
  const start = Date.now();

  await submitTask(taskId, {
    data: { action: "cache-me" },
    protocol: "broker:submit",
    workerId: "test-worker-1",
    timeout: 10000,
    maxRetries: 1,
  });

  // 等待完成
  const final = await waitForCompletion(taskId, 15_000);
  log("DONE", `status=${final.status}`);

  // 查管理 API — 完成后应在终态列表且缓存中同时存在
  const res1 = await fetch(`${GATEWAY_URL}/admin/api/status`);
  const admin1 = (await res1.json()) as Record<string, unknown>;
  const tasks1 = (admin1.tasks as Array<Record<string, unknown>>) ?? [];
  const terminal1 = (admin1.terminal as Array<Record<string, unknown>>) ?? [];
  const cached1 = (admin1.cached as Array<Record<string, unknown>>) ?? [];
  const notInActive = !tasks1.some((t: Record<string, unknown>) => t.taskId === taskId);
  const inTerminal = terminal1.some((t: Record<string, unknown>) => t.taskId === taskId);
  const inCacheBefore = cached1.some((c: Record<string, unknown>) => c.taskId === taskId);

  // 模拟发布者查询取走结果（consumeResult 消费缓存）
  log("FETCH", "发布者查询取走结果...");
  const queryResult = await consumeResult(taskId);
  log("FETCH", `source=${queryResult.source ?? "tasks"} result=${queryResult.result != null}`);

  // 再次查管理 API — 缓存应该已消失，但终态记录仍保留
  const res2 = await fetch(`${GATEWAY_URL}/admin/api/status`);
  const admin2 = (await res2.json()) as Record<string, unknown>;
  const cached2 = (admin2.cached as Array<Record<string, unknown>>) ?? [];
  const terminal2 = (admin2.terminal as Array<Record<string, unknown>>) ?? [];
  const inCacheAfter = cached2.some((c: Record<string, unknown>) => c.taskId === taskId);
  const stillTerminal = terminal2.some((t: Record<string, unknown>) => t.taskId === taskId);

  const duration = Date.now() - start;
  const success = final.status === "completed"
    && inCacheBefore           // 完成后结果在缓存中等待领取
    && !inCacheAfter           // 查询后缓存被消费掉
    && inTerminal && stillTerminal;  // 终态记录始终保留

  if (notInActive) log("CHECK", `✅ 完成时不在活跃列表`);
  if (inTerminal) log("CHECK", `✅ 完成时在终态列表`);
  if (inCacheBefore) log("CHECK", `✅ 结果在缓存中等待领取`);
  if (!inCacheAfter) log("CHECK", `✅ 查询后缓存已消费`);
  if (stillTerminal) log("CHECK", `✅ 终态记录仍保留`);
  log(success ? "PASS" : "FAIL",
    `inCacheBefore=${inCacheBefore} inCacheAfter=${inCacheAfter} inTerminal=${inTerminal} stillTerminal=${stillTerminal} duration=${duration}ms`);

  return {
    taskId,
    description: desc,
    success,
    status: final.status as string,
    timeline: final.timeline as Array<Record<string, unknown>>,
    result: final.result,
    duration,
  };
}


async function testResult(): Promise<TaskResult> {
  const taskId = makeTaskId("test-result");
  const desc = "拿结果：peek轮询 → 完成后消费缓存";
  log("RUN", `${desc} [${taskId}]`);
  const start = Date.now();

  await submitTask(taskId, {
    data: { action: "result-me" },
    protocol: "broker:submit",
    workerId: "test-worker-1",
    timeout: 10000,
    maxRetries: 1,
  });

  // peek 轮询，不消费缓存
  const final = await waitForCompletion(taskId, 15_000);
  log("DONE", `status=${final.status}`);

  let cacheHit = false;
  let resultConsumed = false;
  let terminalStill = false;

  if (final.status === "completed") {
    // 查缓存确认存在
    const res1 = await fetch(`${GATEWAY_URL}/admin/api/status`);
    const admin1 = (await res1.json()) as Record<string, unknown>;
    const before = (admin1.cached as Array<Record<string, unknown>>) ?? [];
    if (before.some((c) => c.taskId === taskId)) log("CHECK", "✅ 结果已在缓存中");

    // 显式消费结果
    log("CONSUME", "取走结果（peek=false）...");
    const consumed = await consumeResult(taskId);
    cacheHit = consumed.source === "cache";
    resultConsumed = consumed.result != null;
    log(cacheHit ? "CONSUME" : "CONSUME",
      `source=${consumed.source ?? "tasks"} result=${consumed.result != null}`);

    // 消费后缓存消失
    const res2 = await fetch(`${GATEWAY_URL}/admin/api/status`);
    const admin2 = (await res2.json()) as Record<string, unknown>;
    const after = (admin2.cached as Array<Record<string, unknown>>) ?? [];
    const terminal = (admin2.terminal as Array<Record<string, unknown>>) ?? [];
    const cacheGone = !after.some((c) => c.taskId === taskId);
    terminalStill = terminal.some((t) => t.taskId === taskId);
    if (cacheGone) log("CHECK", "✅ 消费后缓存已清理");
    if (terminalStill) log("CHECK", "✅ 终态记录仍保留");
  }

  const duration = Date.now() - start;
  const success = final.status === "completed" && cacheHit && resultConsumed && terminalStill;
  log(success ? "PASS" : "FAIL",
    `cacheHit=${cacheHit} resultConsumed=${resultConsumed} terminalStill=${terminalStill} duration=${duration}ms`);

  return {
    taskId,
    description: desc,
    success,
    status: final.status as string,
    result: final.result,
    duration,
  };
}

async function getResult(): Promise<TaskResult> {
  const desc = "只拿结果：消费已有缓存";
  log("RUN", desc);
  const start = Date.now();

  // 从管理 API 找第一个可用缓存
  const res1 = await fetch(`${GATEWAY_URL}/admin/api/status`);
  const admin = (await res1.json()) as Record<string, unknown>;
  const cached = (admin.cached as Array<Record<string, unknown>>) ?? [];
  const entry = cached[0];

  if (!entry?.taskId) {
    log("SKIP", "当前无缓存，跳过");
    return {
      taskId: "-",
      description: desc,
      success: true, // 无缓存不算失败
      status: "no_cache",
      duration: Date.now() - start,
    };
  }

  const taskId = entry.taskId as string;
  log("FETCH", `发现缓存 task=${taskId}`);

  const res = await consumeResult(taskId);
  const duration = Date.now() - start;
  const success = res.status === "completed" && res.source === "cache" && res.result != null;
  log(success ? "PASS" : "FAIL",
    `task=${taskId} source=${res.source ?? "?"} hasResult=${res.result != null} duration=${duration}ms`);

  return {
    taskId,
    description: desc,
    success,
    status: res.status as string,
    result: res.result,
    fromCache: res.source === "cache",
    duration,
  };
}

const SCENARIOS: Record<string, { desc: string; fn: () => Promise<TaskResult> }> = {
  happy: { desc: "合规执行者", fn: testHappy },
  dead: { desc: "死信路径", fn: testDead },
  caps: { desc: "能力匹配", fn: testCaps },
  cache: { desc: "缓存验证", fn: testCache },
  result: { desc: "拿结果", fn: testResult },
  get: { desc: "只拿结果", fn: getResult },
};

// ─── main ───

async function main() {
  // 过滤掉 node 和 TypeScript 标志位
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const names = args.length > 0 ? args : Object.keys(SCENARIOS);

  const selected = names.filter((n) => SCENARIOS[n]);

  if (selected.length === 0) {
    console.log("未知场景，可用:", Object.keys(SCENARIOS).join(", "));
    process.exit(1);
  }

  console.log("=".repeat(60));
  console.log(`Broker 端到端测试 | 网关: ${GATEWAY_URL} | 场景: ${selected.join(", ")}`);
  console.log("=".repeat(60));

  try {
    await fetch(`${GATEWAY_URL}/pivots`, { headers: { Cookie: AUTH_COOKIE } });
  } catch {
    console.error("❌ 网关不可达！请先: API_ADMIN=true node --experimental-strip-types src/index.ts");
    process.exit(1);
  }

  const results: TaskResult[] = [];
  for (const name of selected) {
    console.log("");
    results.push(await SCENARIOS[name].fn());
  }

  // 报告
  console.log("\n" + "=".repeat(60));
  console.log("测试报告");
  console.log("=".repeat(60));
  let passed = 0;
  for (const r of results) {
    const icon = r.success ? "✅" : "❌";
    console.log(`${icon} ${r.description}`);
    console.log(`   taskId=${r.taskId}  status=${r.status}  duration=${r.duration}ms`);
    if (r.timeline) {
      const steps = r.timeline.map((t: Record<string, unknown>) =>
        `${t.status}${t.extra ? `(${t.extra})` : ""}`).join(" → ");
      console.log(`   timeline: ${steps}`);
    }
    if (r.fromCache) console.log("   💾 缓存命中");
    if (r.error) console.log(`   error: ${r.error}`);
    if (r.result) console.log(`   result: ${JSON.stringify(r.result)}`);
    if (r.success) passed++;
  }
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});

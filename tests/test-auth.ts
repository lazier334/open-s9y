/**
 * 认证功能测试
 *
 * 前置条件：网关已启动且已加载 audit 插件
 *   node --env-file=.env.development --experimental-strip-types src/index.ts
 *
 * 运行：node --experimental-strip-types tests/test-auth.ts
 */

import { test, summary } from "./lib/result.ts";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const WS_URL = GATEWAY_URL.replace(/^http/, "ws");

// ─── 辅助函数 ───

async function httpPost(
  body: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  return fetch(`${GATEWAY_URL}/s9y`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function httpGet(
  params: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  const url = new URL("/s9y", GATEWAY_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return fetch(url, { method: "GET", headers });
}

const pushBody = {
  senderId: "test-runner", type: "push",
  payload: { data: "hello" },
  traceId: crypto.randomUUID(), timestamp: Date.now(),
};

const pivotsBody = {
  senderId: "test-runner", type: "pivots", payload: {},
  traceId: crypto.randomUUID(), timestamp: Date.now(),
};

// ─── 连通性检查 ───

let gatewayOk = false;

await test("网关可达", "网关服务应可访问", async () => {
  const res = await httpPost(pushBody, "s9y-key=user");
  if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
  gatewayOk = true;
});

if (!gatewayOk) {
  console.log("\n  网关不可达，请先启动: npm run dev");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════
//  HTTP 认证
// ═══════════════════════════════════════════════════════════

await test("HTTP: POST /s9y 无 cookie → 401", "未认证请求应被拒绝", async () => {
  const res = await httpPost(pushBody);
  if (res.status !== 401) throw new Error(`期望 401，实际 ${res.status}`);
});

await test("HTTP: GET /s9y 无 cookie → 401", "未认证长轮询应被拒绝", async () => {
  const res = await httpGet({ pivotId: "test-pivot", type: "tool" });
  if (res.status !== 401) throw new Error(`期望 401，实际 ${res.status}`);
});

await test("HTTP: POST /s9y (pivots) 无 cookie → 401", "未认证查询应被拒绝", async () => {
  const res = await httpPost(pivotsBody);
  if (res.status !== 401) throw new Error(`期望 401，实际 ${res.status}`);
});

await test("HTTP: POST /s9y 带 cookie → 通过", "已认证请求应被接受", async () => {
  const res = await httpPost(pushBody, "s9y-key=user");
  if (res.status === 401) throw new Error("不应返回 401");
});

await test("HTTP: GET /s9y 带 cookie → 通过（长轮询挂起）", "已认证长轮询应被接受", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    await httpGet({ pivotId: "test-pivot-auth", type: "tool" }, "s9y-key=user");
  } catch (err: any) {
    if (err.name === "AbortError") return; // 长轮询被 abort = 认证通过
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

await test("HTTP: POST /s9y (pivots) 带 cookie → 通过", "已认证查询应被接受", async () => {
  const res = await httpPost(pivotsBody, "s9y-key=user");
  if (res.status === 401) throw new Error("不应返回 401");
});

// ═══════════════════════════════════════════════════════════
//  WebSocket 认证
// ═══════════════════════════════════════════════════════════

await test("WS: 无 cookie → 连接被拒 (1008)", "未认证 WebSocket 应被关闭", async () => {
  const { WebSocket } = await import("ws");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => { ws.close(); resolve(); }, 5000);
    ws.on("error", () => {});
    ws.on("close", (code: number) => {
      clearTimeout(timer);
      if (code !== 1008) throw new Error(`期望关闭码 1008，实际 ${code}`);
      resolve();
    });
  });
});

await test("WS: 带 cookie → 连接通过", "已认证 WebSocket 应保持连接", async () => {
  const { WebSocket } = await import("ws");
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL, { headers: { Cookie: "s9y-key=user" } } as any);
    const timer = setTimeout(() => { ws.close(); resolve(); }, 3000);
    ws.on("error", () => {});
    ws.on("close", (code: number) => {
      clearTimeout(timer);
      if (code === 1008) throw new Error("连接不应被拒绝");
      resolve();
    });
  });
});

summary("认证功能测试");

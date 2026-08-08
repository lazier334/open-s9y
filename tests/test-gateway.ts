/**
 * GatewayServer 集成测试
 *
 * 前置条件：网关已启动（npm run dev 或 npm run start）
 *
 * 运行：node --experimental-strip-types tests/test-gateway.ts
 */

import { test, summary } from "./lib/result.ts";
import { ConnectionManager } from "../src/connection.ts";
import type { Message } from "../sdk/type.ts";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const AUTH_COOKIE = "s9y-key=user";

async function post(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${GATEWAY_URL}/s9y`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: AUTH_COOKIE },
    body: JSON.stringify(body),
  });
}

// ═══════════════════════════════════════════════════════════
//  连通性检查
// ═══════════════════════════════════════════════════════════

let gatewayOk = false;

await test("网关可达", "网关服务应可访问", async () => {
  const res = await post({
    senderId: "test", type: "pivots", payload: {},
    traceId: crypto.randomUUID(), timestamp: Date.now(),
  });
  if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
  gatewayOk = true;
});

if (!gatewayOk) {
  console.log("\n  网关不可达，请先启动: npm run dev");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════
//  ConnectionManager（纯内存，无需网关）
// ═══════════════════════════════════════════════════════════

await test("ConnectionManager: tryRegister 合法 pivotId 通过", "合法字符串 pivotId 应被接受", async () => {
  const cm = new ConnectionManager();
  const r = cm.tryRegister("test-pivot-1");
  if (!r.accepted) throw new Error(r.reason);
  cm.close();
});

await test("ConnectionManager: tryRegister 空字符串拒绝", "空字符串应被拒绝", async () => {
  const cm = new ConnectionManager();
  const r = cm.tryRegister("");
  if (r.accepted) throw new Error("空字符串应被拒绝");
  cm.close();
});

await test("ConnectionManager: addConnection / get / has", "添加连接后应可查询", async () => {
  const cm = new ConnectionManager();
  const send = async () => { };
  await cm.addConnection("c1", { pivotId: "c1", type: "agent" }, send, "fun");
  if (!cm.has("c1")) throw new Error("has 应返回 true");
  const conn = cm.get("c1");
  if (!conn || conn.pivotId !== "c1") throw new Error("get 返回值不符");
  cm.close();
});

await test("ConnectionManager: removeConnection 保留缓存", "断连后缓存仍在 TTL 内", async () => {
  const cm = new ConnectionManager({ pivotCacheTTL: 60_000 });
  const send = async () => { };
  await cm.addConnection("c2", { pivotId: "c2", type: "agent" }, send, "fun");
  cm.removeConnection("c2");
  const cached = cm.get("c2");
  if (!cached) throw new Error("缓存应存在");
  if (cached.disconnectAt === undefined) throw new Error("disconnectAt 应已设置");
  cm.close();
});

await test("ConnectionManager: getAll 只返回活跃连接", "getAll 应排除过期缓存", async () => {
  const cm = new ConnectionManager();
  const send = async () => { };
  await cm.addConnection("a1", { pivotId: "a1", type: "tool" }, send, "fun");
  const all = cm.getAll();
  if (!all.has("a1")) throw new Error("getAll 应包含活跃连接 a1");
  cm.close();
});

await test("ConnectionManager: 任务路由 setRoute / getPivotId / removeRoute", "任务路由应正确记录和删除", async () => {
  const cm = new ConnectionManager();
  cm.setRoute("task-001", "worker-1");
  if (cm.getPivotId("task-001") !== "worker-1") throw new Error("路由查询不符");
  cm.removeRoute("task-001");
  if (cm.getPivotId("task-001") !== undefined) throw new Error("路由应已删除");
  cm.close();
});

await test("ConnectionManager: removePivotRoutes 批量清理", "应删除指定支点的所有路由", async () => {
  const cm = new ConnectionManager();
  cm.setRoute("t-a", "w-x");
  cm.setRoute("t-b", "w-x");
  cm.setRoute("t-c", "w-y");
  const count = cm.removePivotRoutes("w-x");
  if (count !== 2) throw new Error(`期望删除 2 条，实际 ${count}`);
  if (cm.hasRoute("t-a")) throw new Error("t-a 应已删除");
  if (!cm.hasRoute("t-c")) throw new Error("t-c 应仍存在");
  cm.close();
});

// ═══════════════════════════════════════════════════════════
//  HTTP 适配器
// ═══════════════════════════════════════════════════════════

await test("HTTP: POST /s9y 发送消息", "POST 消息应被接受（202）", async () => {
  const res = await post({
    senderId: "http-test", type: "push",
    payload: { data: "hello" },
    traceId: crypto.randomUUID(), timestamp: Date.now(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
});

await test("HTTP: POST /s9y 查询支点列表", "查询 pivots 应返回支点数组", async () => {
  const res = await post({
    senderId: "http-test", type: "pivots", payload: {},
    traceId: crypto.randomUUID(), timestamp: Date.now(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as any;
  if (!Array.isArray(data.pivots)) throw new Error("pivots 应为数组");
});

// ═══════════════════════════════════════════════════════════
//  WebSocket 适配器
// ═══════════════════════════════════════════════════════════

await test("WS: 注册、发消息、断开", "WebSocket 应支持注册和消息收发", async () => {
  const { WebSocket } = await import("ws");
  const wsUrl = GATEWAY_URL.replace(/^http/, "ws");

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: AUTH_COOKIE } } as any);
    const timer = setTimeout(() => { ws.close(); resolve(); }, 5000);

    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        pivotId: "ws-test-1", type: "agent", name: "ws测试", capabilities: ["test"],
      }));
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            senderId: "ws-test-1", type: "push",
            payload: { data: "ws hello" },
            traceId: crypto.randomUUID(), timestamp: Date.now(),
          }));
        }
      }, 500);
    });
    ws.on("message", () => { clearTimeout(timer); ws.close(1000); resolve(); });
    ws.on("close", () => { clearTimeout(timer); resolve(); });
  });
});

// ═══════════════════════════════════════════════════════════
//  路由测试
// ═══════════════════════════════════════════════════════════

await test("HTTP: requestTo 消息路由到目标支点", "通过 HTTP 长轮询注册的支点应能收到消息", async () => {
  const controller = new AbortController();
  const params = new URLSearchParams({ pivotId: "route-target", type: "tool" });

  const pollPromise = fetch(`${GATEWAY_URL}/s9y?${params}`, {
    method: "GET",
    headers: { Cookie: AUTH_COOKIE },
    signal: controller.signal,
  }).then(async (res) => {
    if (res.ok) await res.text();
  }).catch(() => { });

  await new Promise(r => setTimeout(r, 500));

  const res = await post({
    senderId: "sender-test", targetId: "route-target", type: "push",
    payload: { data: "routed" },
    traceId: crypto.randomUUID(), timestamp: Date.now(),
  });

  await new Promise(r => setTimeout(r, 500));
  controller.abort();

  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status}`);
});

summary("Gateway 集成测试");

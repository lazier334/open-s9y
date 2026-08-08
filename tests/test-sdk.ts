/**
 * SDK 单元测试
 *
 * 使用 FunSdk（本地模式）测试 SDK 核心逻辑，无需启动网关。
 *
 * 运行：node --experimental-strip-types tests/test-sdk.ts
 */

import { test, summary } from "./lib/result.ts";
import { FunSdk, LocalMessageBus } from "../sdk/fun-sdk.ts";
import type { Message } from "../sdk/type.ts";

// ═══════════════════════════════════════════════════════════
//  LocalMessageBus
// ═══════════════════════════════════════════════════════════

await test("LocalMessageBus: register / has / unregister", "本地消息总线基本注册和注销", async () => {
  const bus = new LocalMessageBus();
  bus.register("a", async () => "ok");
  if (!bus.has("a")) throw new Error("注册后应存在");
  bus.unregister("a");
  if (bus.has("a")) throw new Error("注销后应不存在");
});

await test("LocalMessageBus: 重复注册抛错", "同一 pivotId 不能注册两次", async () => {
  const bus = new LocalMessageBus();
  bus.register("x", async () => "ok");
  try {
    bus.register("x", async () => "ok");
    throw new Error("应该抛出异常");
  } catch (err: any) {
    if (!err.message.includes("已注册")) throw err;
  }
  bus.unregister("x");
});

await test("LocalMessageBus: send 路由到正确处理器", "消息应被路由到 targetId 对应的处理器", async () => {
  const bus = new LocalMessageBus();
  bus.register("target", async (msg: Message) => ({ echo: msg.payload?.data }));
  const result = await bus.send({
    senderId: "caller", targetId: "target", type: "push",
    payload: { data: "hello" }, traceId: "t1", timestamp: Date.now(),
  });
  if (JSON.stringify(result) !== '{"echo":"hello"}') throw new Error(`结果不符: ${JSON.stringify(result)}`);
  bus.unregister("target");
});

await test("LocalMessageBus: send 到不存在的处理器抛错", "目标不存在时应抛出异常", async () => {
  const bus = new LocalMessageBus();
  try {
    await bus.send({
      senderId: "caller", targetId: "ghost", type: "push",
      payload: {}, traceId: "t2", timestamp: Date.now(),
    });
    throw new Error("应该抛出异常");
  } catch (err: any) {
    if (!err.message.includes("目标处理器不存在")) throw err;
  }
});

// ═══════════════════════════════════════════════════════════
//  FunSdk
// ═══════════════════════════════════════════════════════════

await test("FunSdk: connect 后 connected 状态正确", "连接后 connected 应为 true", async () => {
  const sdk = new FunSdk({ pivotId: "sdk-check", type: "agent" });
  await sdk.connect();
  if (!(sdk as any).connected) throw new Error("connected 应为 true");
  sdk.disconnect();
  if ((sdk as any).connected) throw new Error("断开后 connected 应为 false");
});

await test("FunSdk: 单向推送 (wait=false)", "推送不等待响应，立即返回", async () => {
  const a = new FunSdk({ pivotId: "push-a", type: "agent" });
  const b = new FunSdk({ pivotId: "push-b", type: "agent" });
  b.on({ onMessage: async () => "ok" });
  await a.connect();
  await b.connect();
  await a.send({ data: "ping" }, { targetId: "push-b" });
  a.disconnect();
  b.disconnect();
});

await test("FunSdk: RPC 调用 (wait=true) 返回结果", "等待响应模式应返回处理器的返回值", async () => {
  const a = new FunSdk({ pivotId: "rpc-a", type: "agent" });
  const b = new FunSdk({ pivotId: "rpc-b", type: "agent" });
  b.on({ onMessage: async (msg) => ({ echo: msg.payload?.data, from: "b" }) });
  await a.connect();
  await b.connect();
  const result = await a.send(
    { data: { val: 42 } },
    { targetId: "rpc-b", wait: true }
  );
  if ((result as any).from !== "b") throw new Error(`结果不符: ${JSON.stringify(result)}`);
  a.disconnect();
  b.disconnect();
});

await test("FunSdk: 并发 RPC 调用", "5 个并发请求应全部成功返回", async () => {
  const a = new FunSdk({ pivotId: "conc-a", type: "agent" });
  const b = new FunSdk({ pivotId: "conc-b", type: "agent" });
  b.on({ onMessage: async (msg) => ({ idx: msg.payload?.data }) });
  await a.connect();
  await b.connect();
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      a.send({ data: i }, { targetId: "conc-b", wait: true })
    )
  );
  if (results.length !== 5) throw new Error(`期望 5 个结果，实际 ${results.length}`);
  a.disconnect();
  b.disconnect();
});

await test("FunSdk: RPC 超时", "处理器延迟超过超时时间应抛出超时错误", async () => {
  const a = new FunSdk({ pivotId: "to-a", type: "agent" });
  const slow = new FunSdk({ pivotId: "to-slow", type: "agent", requestTimeout: 500 });
  slow.on({ onMessage: async () => { await new Promise(r => setTimeout(r, 5000)); return "never"; } });
  await a.connect();
  await slow.connect();
  try {
    await a.send({ data: "slow" }, { targetId: "to-slow", wait: true, timeout: 500 });
    throw new Error("应该超时");
  } catch (err: any) {
    if (!err.message.includes("超时")) throw err;
  }
  a.disconnect();
  slow.disconnect();
});

await test("FunSdk: cancel 取消待响应请求", "取消后应立即 reject", async () => {
  const a = new FunSdk({ pivotId: "cancel-a", type: "agent" });
  const slow = new FunSdk({ pivotId: "cancel-slow", type: "agent" });
  slow.on({ onMessage: async () => { await new Promise(r => setTimeout(r, 3000)); return "delayed"; } });
  await a.connect();
  await slow.connect();
  const p = a.send({ data: "x" }, { targetId: "cancel-slow", wait: true, timeout: 10000 });
  await new Promise(r => setTimeout(r, 100));
  const traceId = Array.from((a as any).pendingRequests.keys())[0];
  a.cancel(traceId, "用户取消");
  try {
    await p;
    throw new Error("应该被取消");
  } catch (err: any) {
    if (!err.message.includes("用户取消")) throw err;
  }
  a.disconnect();
  slow.disconnect();
});

await test("FunSdk: 私有总线隔离", "不同私有总线上的支点互不可见", async () => {
  const handler = async () => ({ private: true });
  const a = new FunSdk({ pivotId: "iso-a", type: "agent", localHandler: handler });
  const b = new FunSdk({ pivotId: "iso-b", type: "agent", localHandler: handler });
  await a.connect();
  await b.connect();
  try {
    await a.send({ data: "x" }, { targetId: "iso-b", wait: true });
    throw new Error("应该抛出异常");
  } catch (err: any) {
    if (!err.message.includes("目标处理器不存在")) throw err;
  }
  a.disconnect();
  b.disconnect();
});

summary("SDK 单元测试");

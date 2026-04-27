/**
 * 原生 WebSocket 实现的 other 类型客户端（最小可行性）
 * - 不依赖 BasePivot
 * - 手动完成注册、心跳、任务接收
 * - 纯 WS 模式，不处理 pipe 查询（若需要 pipe，请使用 HTTP 模式）
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-other-ws.ts
 */

import { WebSocket } from "ws";
import type { Message } from "../sdk/type.ts";

const gatewayUrl = process.env.GATEWAY_URL ?? "ws://localhost:3000";
const pivotId = process.env.CLIENT_ID ?? "fake-other-ws-01";
const heartbeatInterval = 30_000;

let ws: WebSocket;
let heartbeatTimer: NodeJS.Timeout;

// 模拟任务存储
const taskResults = new Map<string, unknown>();

function connect() {
  return new Promise<void>((resolve, reject) => {
    ws = new WebSocket(gatewayUrl);

    ws.once("open", () => {
      // 发送注册消息
      const registerMsg: Message = {
        senderId: pivotId,
        type: "register",
        payload: { pivotId, type: "other", capabilities: { custom: true }, priceTable: "other-dynamic" },
        traceId: crypto.randomUUID(),
        timestamp: Date.now(),
      };
      ws.send(JSON.stringify(registerMsg));

      // 启动心跳
      heartbeatTimer = setInterval(() => {
        const hb: Message = {
          senderId: pivotId,
          type: "heartbeat",
          payload: {},
          traceId: crypto.randomUUID(),
          timestamp: Date.now(),
        };
        ws.send(JSON.stringify(hb));
      }, heartbeatInterval);

      resolve();
    });

    ws.once("error", reject);
    ws.on("message", handleMessage);
    ws.on("close", (code, reason) => {
      clearInterval(heartbeatTimer);
      console.log(`[OtherWS] 连接已关闭 code=${code} reason=${reason.toString()}`);
    });
  });
}

function handleMessage(raw: Buffer) {
  const msg = JSON.parse(raw.toString()) as Message;

  // 处理网关推送的任务
  if (msg.type === "push") {
    const taskId = msg.payload?.taskId as string;
    const data = msg.payload?.data;

    console.log(`[OtherWS] 收到任务 taskId=${taskId}`);
    console.log(`[OtherWS] 任务数据:`, JSON.stringify(data, null, 2));

    // 模拟处理并记录结果
    taskResults.set(taskId ?? "unknown", {
      processedBy: pivotId,
      timestamp: new Date().toISOString(),
      input: data,
    });

    // 主动回传进度（演示 send 用法）
    const progressMsg: Message = {
      senderId: pivotId,
      targetId: msg.senderId,
      type: "progress",
      payload: {
        taskId,
        data: { step: 1, content: "任务已接收" },
        cost: "0.005",
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(progressMsg));

    // 主动回传结果
    const resultMsg: Message = {
      senderId: pivotId,
      targetId: msg.senderId,
      type: "result",
      payload: {
        taskId,
        data: { done: true, summary: `任务 ${taskId} 处理完成` },
        cost: "0.01",
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    ws.send(JSON.stringify(resultMsg));
  }
}

async function main() {
  await connect();
  console.log(`[OtherWS] 已连接到网关，pivotId=${pivotId}`);

  process.on("SIGINT", () => {
    console.log("\n[OtherWS] 断开连接");
    clearInterval(heartbeatTimer);
    ws.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("[OtherWS] 启动失败:", err);
  process.exit(1);
});

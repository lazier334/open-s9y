import type { FastifyInstance, FastifyReply } from "fastify";
import type { Message, GatewayAPI } from "../sdk/type.ts";
import type { BasePivot } from "../sdk/base-pivot-sdk.ts";
import type { Server } from "node:http";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { ConnectionManager } from "./connection.ts";
import { WsAdapter } from "./adapter/ws-adapter.ts";
import { HttpAdapter } from "./adapter/http-adapter.ts";
import { scanAndRegister } from "./adapter/fun-adapter.ts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

type PipeWaiter = {
  reply: FastifyReply;
  timer: NodeJS.Timeout;
};

export interface GatewayServerOptions {
  port?: number;
  heartbeatInterval?: number;
  pivotTimeout?: number;
  requestTimeout?: number;
  pivotCacheTTL?: number;
  pluginPivotId?: string;
}

/**
 * 网关服务器主类
 * - HTTP + WebSocket 双协议入口，协议处理委托给适配器
 * - 连接治理（ConnectionManager）、GatewayAPI 实现
 * - handleBizMessage 为协议无关的业务消息处理
 */
export class GatewayServer implements GatewayAPI {
  fastify: FastifyInstance;
  wss: WebSocketServer;
  connections: ConnectionManager;
  pluginPivotId?: string;

  /** 待响应的请求 Map（traceId → PendingRequest），适配器需访问 */
  readonly pendingRequests = new Map<string, PendingRequest>();
  /** 已完成的 taskId 集合 */
  readonly completedTasks = new Set<string>();
  /** 管道等待者 Map，http-adapter 需访问 */
  readonly pipeWaiters = new Map<string, PipeWaiter>();
  /** 请求超时时间（ms），适配器需访问 */
  readonly requestTimeout: number;

  constructor(options: GatewayServerOptions = {}) {
    this.fastify = Fastify({ logger: false });
    this.wss = new WebSocketServer({ server: this.fastify.server as Server });
    this.requestTimeout = options.requestTimeout ?? 30_000;
    this.pluginPivotId = options.pluginPivotId;

    this.fastify.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, done) => done(null, payload)
    );

    this.connections = new ConnectionManager(
      {
        heartbeatInterval: options.heartbeatInterval,
        pivotTimeout: options.pivotTimeout,
        pivotCacheTTL: options.pivotCacheTTL,
      },
      {
        onDisconnect: (_pivotId) => {
          // 本地 pivot 不依赖此回调
        },
      }
    );

    // 委托协议处理给适配器
    new WsAdapter(this).setup(this.wss);
    new HttpAdapter(this).register(this.fastify);
  }

  /** 注册本地 pivot（同一进程内直接调用） */
  registerLocalPivot(pivotId: string, pivot: BasePivot): void {
    this.connections.addLocal(pivotId, pivot);
  }

  /** 获取所有支点信息（远程连接 + 本地 pivot） */
  getAllPivots(): Array<{
    pivotId: string;
    type: string;
    name?: string;
    capabilities?: Record<string, unknown>;
  }> {
    const result: Array<{
      pivotId: string;
      type: string;
      name?: string;
      capabilities?: Record<string, unknown>;
    }> = [];
    for (const [pid, conn] of this.connections.getAll()) {
      result.push({
        pivotId: pid,
        type: conn.pivotInfo.type ?? "other",
        name: conn.pivotInfo.name,
        capabilities: conn.pivotInfo.capabilities,
      });
    }
    return result.concat(this.connections.getLocalPivotsInfo());
  }

  /** 启动 HTTP 服务器监听 */
  async listen(port?: number): Promise<string> {
    await scanAndRegister(this);
    const address = await this.fastify.listen({
      port: port ?? 3000,
      host: "0.0.0.0",
    });
    return address;
  }

  /** 关闭服务器 */
  async close(): Promise<void> {
    for (const waiter of this.pipeWaiters.values()) {
      clearTimeout(waiter.timer);
      if (!waiter.reply.sent) {
        waiter.reply.code(503).send({ error: "网关正在关闭" });
      }
    }
    this.pipeWaiters.clear();

    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error("网关正在关闭"));
    }
    this.pendingRequests.clear();
    this.completedTasks.clear();

    this.connections.close();
    this.wss.close();
    await this.fastify.close();
  }

  // ─── GatewayAPI 实现 ───

  async routeTo(pivotId: string, message: Message): Promise<void> {
    const local = this.connections.getLocal(pivotId);
    if (local) {
      local.onTask(message).catch(() => { });
      return;
    }

    const trySend = (): boolean => {
      const conn = this.connections.get(pivotId);
      if (!conn) return false;
      try {
        conn.send(message);
        return true;
      } catch (err) {
        console.error("消息发送失败，准备重试:", err);
        return false;
      }
    };

    if (trySend()) return;

    const MAX_WAIT = 5000;
    const INTERVAL = 500;
    const start = Date.now();

    while (Date.now() - start < MAX_WAIT) {
      await new Promise((r) => setTimeout(r, INTERVAL));
      if (trySend()) return;
    }

    throw new Error(`支点离线: ${pivotId}`);
  }

  openStream(_pivotId: string, _message: Message): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.close();
      },
    });
  }

  requestTo(pivotId: string, message: Message): Promise<unknown> {
    const local = this.connections.getLocal(pivotId);
    if (local) {
      return Promise.resolve(local.onTask(message));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(message.traceId)) {
          this.pendingRequests.delete(message.traceId);
          reject(new Error("请求超时"));
        }
      }, this.requestTimeout);

      this.pendingRequests.set(message.traceId, { resolve, reject, timer });
      this.routeTo(pivotId, message).catch((err) => {
        clearTimeout(timer);
        this.pendingRequests.delete(message.traceId);
        reject(err);
      });
    });
  }

  // ─── 协议无关的业务消息处理 ───

  /**
   * 统一处理业务消息（push / pivots 等）
   * WS / HTTP 适配器共用，返回非 undefined 时由适配器负责响应
   */
  async handleBizMessage(message: Message): Promise<unknown> {
    if (message.type === "pivots") {
      const all = this.connections.getAll();
      const remote = Array.from(all.entries()).map(([pid, conn]) => ({
        pivotId: pid,
        type: conn.pivotInfo.type,
        name: conn.pivotInfo.name,
        capabilities: conn.pivotInfo.capabilities,
        adapterType: conn.socket ? "ws" as const : "http" as const,
        status: conn.status,
      }));
      const local = this.connections.getLocalPivotsInfo().map((p) => ({
        ...p,
        adapterType: "fun" as const,
      }));
      return { pivots: [...remote, ...local] };
    }

    const targetPivotId = await this._resolveTargetPivotId(message);

    if (message.payload?.sync) {
      const response = await this.requestTo(targetPivotId, {
        ...message,
        targetId: targetPivotId,
      });
      if (message.payload?.taskId) {
        this.connections.setRoute(message.payload.taskId, targetPivotId);
      }
      return response;
    }

    await this.routeTo(targetPivotId, { ...message, targetId: targetPivotId });
    if (message.payload?.taskId) {
      this.connections.setRoute(message.payload.taskId, targetPivotId);
    }
    return { status: "accepted", taskId: message.payload?.taskId };
  }

  /** 解析目标支点 ID：有 targetId 直接使用，否则请求插件 pivot 路由 */
  private async _resolveTargetPivotId(message: Message): Promise<string> {
    if (message.targetId) return message.targetId;

    if (!this.pluginPivotId) throw new Error("未配置插件 pivot");

    const pluginMsg: Message = {
      senderId: "gateway",
      targetId: this.pluginPivotId,
      type: "push",
      payload: message.payload,
      traceId: randomUUID(),
      timestamp: Date.now(),
    };
    return (await this.requestTo(this.pluginPivotId, pluginMsg)) as string;
  }
}

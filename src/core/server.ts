import Fastify from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  Message,
  GatewayAPI,
  PivotInfo,
  PivotType,
} from "../protocol/message.ts";
import type { GatewayPlugin } from "../plugin/interface.ts";
import { ConnectionManager } from "./connection.ts";
import { TaskRouter } from "./router.ts";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
};

type StreamController = ReadableStreamDefaultController<Uint8Array>;

export interface GatewayServerOptions {
  port?: number;
  heartbeatInterval?: number;
  pivotTimeout?: number;
  requestTimeout?: number;
  streamTimeout?: number;
}

/**
 * 网关服务器主类
 * - HTTP + WebSocket 双协议入口
 * - 连接治理、任务路由、插件分发
 * - 实现 GatewayAPI 供插件调用
 */
export class GatewayServer implements GatewayAPI {
  fastify: FastifyInstance;
  wss: WebSocketServer;
  connections: ConnectionManager;
  router: TaskRouter;
  plugin?: GatewayPlugin;

  private pendingRequests = new Map<string, PendingRequest>();
  private pendingStreams = new Map<string, StreamController>();
  private requestTimeout: number;
  private streamTimeout: number;

  /**
   * 构造 GatewayServer 实例
   * @param options - 服务器配置选项（端口、心跳间隔、超时时间等）
   */
  constructor(options: GatewayServerOptions = {}) {
    this.fastify = Fastify({ logger: false });
    this.wss = new WebSocketServer({ server: this.fastify.server as Server });
    this.router = new TaskRouter();
    this.requestTimeout = options.requestTimeout ?? 30_000;
    this.streamTimeout = options.streamTimeout ?? 60_000;

    this.connections = new ConnectionManager(
      {
        heartbeatInterval: options.heartbeatInterval,
        pivotTimeout: options.pivotTimeout,
      },
      {
        onDisconnect: (pivotId) => {
          // 保留 taskRouting，由查询时判断是否离线返回错误
          this.plugin?.onPivotDisconnect(pivotId);
        },
      }
    );

    this._setupWebSocket();
    this._setupHttpRoutes();
  }

  /**
   * 挂载插件实例并初始化
   * @param plugin - 实现 GatewayPlugin 接口的插件实例
   */
  setPlugin(plugin: GatewayPlugin): void {
    this.plugin = plugin;
    plugin.initialize(this);
  }

  /**
   * 启动 HTTP 服务器监听
   * @param port - 监听端口，默认 3000
   * @returns 实际监听地址
   */
  async listen(port?: number): Promise<string> {
    const address = await this.fastify.listen({ port: port ?? 3000 });
    return address;
  }

  /**
   * 优雅关闭服务器
   * - 清空所有 pending 的请求和流
   * - 关闭 WebSocketServer 和 Fastify 实例
   */
  async close(): Promise<void> {
    // 清理 pending
    for (const { reject, timer } of this.pendingRequests.values()) {
      clearTimeout(timer);
      reject(new Error("网关正在关闭"));
    }
    this.pendingRequests.clear();
    for (const [traceId, controller] of this.pendingStreams.entries()) {
      controller.close();
      this.pendingStreams.delete(traceId);
    }
    this.wss.close();
    await this.fastify.close();
  }

  // ─── GatewayAPI 实现 ───

  /**
   * 向指定支点发送消息（GatewayAPI 实现）
   * @param pivotId - 目标支点 ID
   * @param message - 要发送的内部 Message
   * @throws 支点离线或 socket 未打开时抛出错误
   */
  async routeTo(pivotId: string, message: Message): Promise<void> {
    const conn = this.connections.get(pivotId);
    if (!conn) {
      throw new Error(`支点离线: ${pivotId}`);
    }
    return new Promise((resolve, reject) => {
      if (conn.socket.readyState !== 1) {
        reject(new Error(`支点 socket 未打开: ${pivotId}`));
        return;
      }
      conn.socket.send(JSON.stringify(message), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * 向指定支点打开一个可读流，用于接收流式进度（GatewayAPI 实现）
   * @param pivotId - 目标支点 ID
   * @param message - 包含 traceId 的 Message，用于关联流式响应
   * @returns ReadableStream<Uint8Array>
   */
  openStream(pivotId: string, message: Message): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.pendingStreams.set(message.traceId, controller);
        this.routeTo(pivotId, message).catch((err) => {
          controller.error(err);
          this.pendingStreams.delete(message.traceId);
        });
        const timer = setTimeout(() => {
          const ctrl = this.pendingStreams.get(message.traceId);
          if (ctrl) {
            ctrl.close();
            this.pendingStreams.delete(message.traceId);
          }
        }, this.streamTimeout);
        // 在 stream close/error 时清理 timer，这里用简单方式处理
        const originalClose = controller.close.bind(controller);
        controller.close = () => {
          clearTimeout(timer);
          originalClose();
        };
      },
      cancel: () => {
        this.pendingStreams.delete(message.traceId);
      },
    });
  }

  /**
   * 向指定支点发送请求并等待响应（GatewayAPI 实现）
   * @param pivotId - 目标支点 ID
   * @param message - 包含 traceId 的 Message，用于关联响应
   * @returns 解析后的响应数据
   */
  requestTo(pivotId: string, message: Message): Promise<unknown> {
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

  // ─── WebSocket 处理 ───

  /**
   * 初始化 WebSocketServer 事件监听
   * - 处理支点连接、消息、关闭、错误事件
   * - 负责心跳、注册、请求/流响应消息分发
   */
  private _setupWebSocket(): void {
    this.wss.on("connection", (socket) => {
      let pivotId: string | undefined;

      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(raw.toString()) as Message;

          // 心跳消息
          if (message.type === "heartbeat") {
            if (pivotId) {
              this.connections.updateHeartbeat(pivotId);
              this.plugin?.onPivotUpdate(pivotId, this.connections.get(pivotId)!.status);
            }
            return;
          }

          // 注册消息
          if (message.type === "register") {
            const info = message.payload as unknown as PivotInfo & { pivotId?: string; type?: PivotType };
            pivotId = info.pivotId ?? message.senderId;
            const pivotInfo: PivotInfo = {
              pivotId,
              type: info.type ?? "other",
              capabilities: info.capabilities,
            };
            const accepted = this.plugin?.onPivotConnect(pivotInfo) ?? true;
            if (!accepted) {
              socket.close(1008, "被插件拒绝");
              return;
            }
            this.connections.add(pivotId, socket, pivotInfo);
            return;
          }

          // 响应消息处理（通过 traceId 关联）
          const pendingReq = this.pendingRequests.get(message.traceId);
          if (pendingReq) {
            clearTimeout(pendingReq.timer);
            this.pendingRequests.delete(message.traceId);
            if (message.payload?.error) {
              pendingReq.reject(new Error(String(message.payload.error)));
            } else {
              pendingReq.resolve(message.payload?.data ?? message.payload);
            }
            return;
          }

          // 流式消息处理
          const pendingStream = this.pendingStreams.get(message.traceId);
          if (pendingStream) {
            if (message.type === "progress") {
              const chunk = JSON.stringify(message.payload?.data ?? message.payload) + "\n";
              pendingStream.enqueue(new TextEncoder().encode(chunk));
            } else if (message.type === "result") {
              if (message.payload?.data !== undefined) {
                const chunk = JSON.stringify(message.payload.data) + "\n";
                pendingStream.enqueue(new TextEncoder().encode(chunk));
              }
              pendingStream.close();
              this.pendingStreams.delete(message.traceId);
            }
            return;
          }

          // 普通上行消息（Agent 主动推送）
          // 当前不做额外处理，可扩展
        } catch {
          // ignore invalid message
        }
      });

      socket.on("close", () => {
        if (pivotId) {
          this.connections.remove(pivotId);
        }
      });

      socket.on("error", () => {
        if (pivotId) {
          this.connections.remove(pivotId);
        }
      });
    });
  }

  // ─── HTTP 路由 ───

  /**
   * 初始化 Fastify HTTP 路由
   * - POST /push   : 提交任务，必经插件决策
   * - GET  /progress/:taskId : 查询进度，网关直连
   * - GET  /result/:taskId   : 查询结果，网关直连
   */
  private _setupHttpRoutes(): void {
    // 提交任务（必经插件）
    this.fastify.post<{ Body: Message }>("/push", async (request, reply) => {
      const message = request.body;
      if (!message?.senderId || !message?.type) {
        return reply.code(400).send({ error: "消息格式无效" });
      }
      if (!this.plugin) {
        return reply.code(503).send({ error: "未加载插件" });
      }

      try {
        const pivotId = await this.plugin.onTaskSubmit(message);
        await this.routeTo(pivotId, { ...message, targetId: pivotId });
        if (message.payload?.taskId) {
          this.router.setRoute(message.payload.taskId, pivotId);
          this.plugin.onTaskAssigned?.(message.payload.taskId, pivotId);
        }
        return reply.code(202).send({ status: "accepted", taskId: message.payload?.taskId });
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 查询进度（网关直连）
    this.fastify.get<{ Params: { taskId: string } }>("/progress/:taskId", async (request, reply) => {
      const { taskId } = request.params;
      const pivotId = this.router.getPivotId(taskId);
      if (!pivotId) {
        return reply.code(404).send({ error: "任务未找到" });
      }
      if (!this.connections.has(pivotId)) {
        return reply.code(503).send({ error: "支点离线，任务中断" });
      }

      const message: Message = {
        senderId: "gateway",
        targetId: pivotId,
        type: "progress",
        payload: { taskId },
        traceId: randomUUID(),
        timestamp: Date.now(),
      };

      try {
        const stream = this.openStream(pivotId, message);
        reply.raw.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Transfer-Encoding": "chunked",
        });
        const reader = stream.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(value);
          }
        } finally {
          reader.releaseLock();
        }
        reply.raw.end();
      } catch (err) {
        if (!reply.sent) {
          return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 查询结果（网关直连）
    this.fastify.get<{ Params: { taskId: string } }>("/result/:taskId", async (request, reply) => {
      const { taskId } = request.params;
      const pivotId = this.router.getPivotId(taskId);
      if (!pivotId) {
        return reply.code(404).send({ error: "任务未找到" });
      }
      if (!this.connections.has(pivotId)) {
        return reply.code(503).send({ error: "支点离线，任务中断" });
      }

      const message: Message = {
        senderId: "gateway",
        targetId: pivotId,
        type: "result",
        payload: { taskId },
        traceId: randomUUID(),
        timestamp: Date.now(),
      };

      try {
        const data = await this.requestTo(pivotId, message);
        return reply.code(200).send({ taskId, data });
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}

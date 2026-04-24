import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  Message,
  GatewayAPI,
  PivotInfo,
  PipeQuery,
} from "../protocol/message.ts";
import type { BasePivot } from "../client/base-pivot.ts";
import { ConnectionManager } from "./connection.ts";
import { TaskRouter } from "./router.ts";

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
  /** 远程插件 pivot 的 ID，设置后优先通过 requestTo 调用远程插件 */
  pluginPivotId?: string;
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
  pluginPivotId?: string;

  private pendingRequests = new Map<string, PendingRequest>();
  private completedTasks = new Set<string>();
  private pipeWaiters = new Map<string, PipeWaiter>();
  private requestTimeout: number;
  private localPivots = new Map<string, BasePivot>();

  /**
   * 构造 GatewayServer 实例
   * @param options - 服务器配置选项（端口、心跳间隔、超时时间等）
   */
  constructor(options: GatewayServerOptions = {}) {
    this.fastify = Fastify({ logger: false });
    this.wss = new WebSocketServer({ server: this.fastify.server as Server });
    this.router = new TaskRouter();
    this.requestTimeout = options.requestTimeout ?? 30_000;
    this.pluginPivotId = options.pluginPivotId;

    // 关键：注册 octet-stream 解析器，告诉 Fastify 这种类型直接给原始流
    this.fastify.addContentTypeParser('application/octet-stream', (request, payload, done) => done(null, payload));
    this.connections = new ConnectionManager(
      {
        heartbeatInterval: options.heartbeatInterval,
        pivotTimeout: options.pivotTimeout,
        pivotCacheTTL: options.pivotCacheTTL,
      },
      {
        onDisconnect: (_pivotId) => {
          // 本地 pivot 不依赖此回调，由 RouterPivot 通过 connections.getAll() 实时获取状态
        },
      }
    );

    this._setupWebSocket();
    this._setupHttpRoutes();
  }

  /**
   * 注册本地 pivot（同一进程内直接调用）
   * @param pivotId - 本地 pivot ID
   * @param pivot - BasePivot 子类实例
   */
  registerLocalPivot(pivotId: string, pivot: BasePivot): void {
    this.localPivots.set(pivotId, pivot);
  }

  /**
   * 获取所有支点信息（远程连接 + 本地 pivot）
   */
  getAllPivots(): Array<{ pivotId: string; type: string; capabilities?: Record<string, unknown> }> {
    const result: Array<{ pivotId: string; type: string; capabilities?: Record<string, unknown> }> = [];
    for (const [pid, conn] of this.connections.getAll()) {
      result.push({
        pivotId: pid,
        type: conn.pivotInfo.type ?? "other",
        capabilities: conn.pivotInfo.capabilities,
      });
    }
    for (const [pid, pivot] of this.localPivots) {
      result.push({
        pivotId: pid,
        type: pivot.options.type ?? "other",
        capabilities: pivot.options.capabilities,
      });
    }
    return result;
  }

  /**
   * 启动 HTTP 服务器监听
   * @param port - 监听端口，默认 3000
   * @returns 实际监听地址
   */
  async listen(port?: number): Promise<string> {
    const address = await this.fastify.listen({ port: port ?? 3000, host: '0.0.0.0' });
    return address;
  }

  /**
   * 优雅关闭服务器
   * - 清空所有 pending 的请求和查询 waiters
   * - 关闭 ConnectionManager、WebSocketServer 和 Fastify 实例
   */
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

  /**
   * 向指定支点发送消息（GatewayAPI 实现）
   * - 统一调用 Connection.send，WS 与 HTTP 的具体实现在 ConnectionManager 中注入
   * - 发送失败或目标离线时，进入重试循环，最多等待 5 秒
   * @param pivotId - 目标支点 ID
   * @param message - 要发送的内部 Message
   * @throws 超过 5 秒仍未成功时抛出 "支点离线" 错误
   */
  async routeTo(pivotId: string, message: Message): Promise<void> {
    const local = this.localPivots.get(pivotId);
    if (local) {
      local.onTask(message).catch(() => {});
      return;
    }

    const trySend = (): boolean => {
      const conn = this.connections.get(pivotId);
      if (!conn) return false;
      try {
        conn.send(message);
        return true;
      } catch (err) {
        console.error('[Gateway] 消息发送失败，准备重试:', err);
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

  /**
   * 向指定支点打开一个可读流，用于接收流式进度（GatewayAPI 实现）
   * 新架构下主要使用 pipeWaiter 管道，此接口保留兼容
   */
  openStream(pivotId: string, message: Message): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.close();
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
    const local = this.localPivots.get(pivotId);
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

  // ─── 统一业务消息处理器 ───

  /**
   * 统一处理业务消息（push / pivots 等）
   * - WS 和 HTTP /push 共用同一套业务逻辑
   * - 返回非 undefined 时，入口层负责响应；返回 undefined 表示静默处理
   * @param message - 内部 Message
   * @returns 业务处理结果；undefined 表示无需响应
   * @throws 插件未加载或路由失败时抛出异常
   */
  private async _handleBizMessage(message: Message): Promise<unknown> {
    if (message.type === "pivots") {
      const all = this.connections.getAll();
      const pivots = Array.from(all.entries()).map(([pid, conn]) => ({
        pivotId: pid,
        type: conn.pivotInfo.type,
        capabilities: conn.pivotInfo.capabilities,
        status: conn.status,
        isHttp: conn.isHttp,
      }));
      return { pivots };
    }

    let targetPivotId: string;

    if (message.targetId) {
      // 直接调用模式：targetId 已指定
      targetPivotId = message.targetId;
    } else if (this.pluginPivotId) {
      // 插件 pivot 模式：通过 requestTo 调用插件 pivot 进行决策
      const pluginMsg: Message = {
        senderId: "gateway",
        targetId: this.pluginPivotId,
        type: "push",
        payload: message.payload,
        traceId: randomUUID(),
        timestamp: Date.now(),
      };
      targetPivotId = (await this.requestTo(this.pluginPivotId, pluginMsg)) as string;
    } else {
      throw new Error("未配置插件 pivot");
    }

    // 同步模式：等待目标支点响应并直接返回（如工具调用）
    if (message.payload?.sync) {
      const response = await this.requestTo(targetPivotId, { ...message, targetId: targetPivotId });
      if (message.payload?.taskId) {
        this.router.setRoute(message.payload.taskId, targetPivotId);
      }
      return response;
    }

    await this.routeTo(targetPivotId, { ...message, targetId: targetPivotId });
    if (message.payload?.taskId) {
      this.router.setRoute(message.payload.taskId, targetPivotId);
    }
    return { status: "accepted", taskId: message.payload?.taskId };

  }

  // ─── WebSocket 处理 ───

  /**
   * 初始化 WebSocketServer 事件监听
   * - 处理支点连接、消息、关闭、错误事件
   * - 负责心跳、注册、push 消息分发
   */
  private _setupWebSocket(): void {
    this.wss.on("connection", (socket) => {
      let pivotId: string | undefined;

      socket.on("message", async (raw: Buffer) => {
        let message = {} as Message;
        try {
          message = JSON.parse(raw.toString()) as Message;

          // 心跳消息（ws专属）
          if (message.type === "heartbeat") {
            if (pivotId) {
              this.connections.updateHeartbeat(pivotId);
            }
            return;
          }

          // 注册消息（ws版本的专门处理）
          if (message.type === "register") {
            const info = message.payload as unknown as PivotInfo & { pivotId?: string };
            pivotId = info.pivotId ?? message.senderId;

            const result = this.connections.tryRegister(pivotId);
            if (!result.accepted) {
              socket.close(1008, result.reason);
              return;
            }

            const cached = this.connections.getCache(pivotId);
            const pivotInfo: PivotInfo = {
              pivotId,
              type: info.type ?? cached?.pivotInfo.type ?? "other",
              capabilities: info.capabilities ?? cached?.pivotInfo.capabilities,
              priceTable: info.priceTable ?? cached?.pivotInfo.priceTable,
            };

            this.connections.addWs(pivotId, pivotInfo, socket);
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

          // 统一业务消息处理（push / pivots 等）
            const result = await this._handleBizMessage(message);
            if (result !== undefined) {
              const response: Message = {
                senderId: "gateway",
                targetId: message.senderId,
                type: message.type,
                payload: { data: result },
                traceId: message.traceId,
                timestamp: Date.now(),
              };
              await this.routeTo(message.senderId, response);
            }
        } catch (err) {
          try{
            const errorResponse: Message = {
              senderId: "gateway",
              targetId: message.senderId,
              type: message.type,
              payload: { error: err instanceof Error ? err.message : String(err) },
              traceId: message.traceId,
              timestamp: Date.now(),
            };
            await this.routeTo(message.senderId, errorResponse);
          } catch (err) {
          // 捕获 JSON.parse 失败、routeTo 发送失败（如发送方已断开）
          console.error("[Gateway] WS 消息处理异常:", err);
          }
        }
      });

      socket.on("close", () => {
        if (pivotId) {
          this.connections.removeWs(pivotId);
        }
      });

      socket.on("error", () => {
        if (pivotId) {
          this.connections.removeWs(pivotId);
        }
      });
    });
  }

  // ─── HTTP 路由 ───

  /**
   * 初始化 Fastify HTTP 路由
   * - POST /push              : 提交任务，必经插件决策
   * - POST /register          : 长轮询注册并等待消息下发
   * - GET  /pipe?taskId=...&protocol=...      : 消费者挂起等待管道数据
   * - POST /pipe?taskId=...&protocol=...      : 生产者回传管道数据
   */
  private _setupHttpRoutes(): void {
    // 注册（长轮询等待消息，http版本专属处理）
    this.fastify.post<{
      Body: Partial<PivotInfo> & { pivotId?: string };
    }>("/register", async (request, reply) => {
      const body = request.body;
      const pivotId = body.pivotId ?? "unknown";
      const send = (msg: any, code: number = 200) => {
        if (!reply.sent) reply.code(code).send(msg);
        else throw new Error('当前请求已响应');
      };

      const result = this.connections.tryRegister(pivotId);
      if (!result.accepted) {
        return send({ error: result.reason }, 409);
      }

      const cached = this.connections.getCache(pivotId);
      const pivotInfo: PivotInfo = {
        pivotId,
        type: body.type ?? cached?.pivotInfo.type ?? "other",
        capabilities: body.capabilities ?? cached?.pivotInfo.capabilities,
        priceTable: body.priceTable ?? cached?.pivotInfo.priceTable,
      };

      const conn = this.connections.addHttp(pivotId, pivotInfo, reply);
      conn.send = send;

      return new Promise<void>((resolve, reject) => {
        // 心跳包定时器id占位符
        let timer: any;
        // 清理连接
        const cleanConn = () => {
          try {
            clearTimeout(timer);
            conn.send = () => { throw new Error("HTTP 连接已断开") };
            if (this.connections.get(pivotId) === conn) {
              this.connections.removeHttp(pivotId);
            }
            resolve();
          } catch (err) {
            reject(err)
          }
        }
        timer = setTimeout(() => {
          send({ type: "noop" }, 200);
          cleanConn();
        }, this.requestTimeout);

        conn.send = (msg: Message) => {
          send(msg, 200);
          cleanConn();
        };
        reply.raw.on('close', cleanConn);
      });
    });

    // 提交任务（必经插件）
    this.fastify.post<{ Body: Message }>("/push", async (request, reply) => {
      const message = request.body;
      if (!message?.senderId || !message?.type) {
        return reply.code(400).send({ error: "消息格式无效" });
      }

      // 检查是否是 pending request 的响应（支持 pivot 回传结果）
      const pendingReq = this.pendingRequests.get(message.traceId);
      if (pendingReq) {
        clearTimeout(pendingReq.timer);
        this.pendingRequests.delete(message.traceId);
        if (message.payload?.error) {
          pendingReq.reject(new Error(String(message.payload.error)));
        } else {
          pendingReq.resolve(message.payload?.data ?? message.payload);
        }
        return reply.code(200).send({ status: "ok" });
      }

      if (!this.pluginPivotId) {
        return reply.code(503).send({ error: "未配置插件 pivot" });
      }

      try {
        const result = await this._handleBizMessage(message);
        return reply.code(202).send(result);
      } catch (err) {
        return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    });

    // 统一管道 /pipe
    this.fastify.get<{ Querystring: PipeQuery }>("/pipe", async (request, reply) => {
      const protocol = request.query.protocol ?? "result";
      const taskId = request.query.taskId;
      let targetPivotId = request.query.targetPivotId;

      if (!targetPivotId) {
        targetPivotId = this.router.getPivotId(taskId);
      }

      if (!targetPivotId) {
        return reply.code(404).send({ error: "目标支点未找到" });
      }
      if (!this.connections.isOnline(targetPivotId)) {
        return reply.code(503).send({ error: "支点离线" });
      }

      this._setPipeWaiter(protocol, taskId, reply);

      const msg: Message = {
        senderId: "gateway",
        targetId: targetPivotId,
        type: "pipe",
        payload: { taskId, protocol },
        traceId: randomUUID(),
        timestamp: Date.now(),
      };

      try {
        await this.routeTo(targetPivotId, msg);
        reply.hijack();
      } catch (err) {
        this._resolvePipeWaiter(protocol, taskId, { error: err instanceof Error ? err.message : String(err) });
      }
    });


    this.fastify.post<{ Querystring: PipeQuery }>("/pipe", {
      // 关键：禁用 body 解析，强制使用原始流
      config: { rawBody: true },
      // 禁用 Fastify 的 body 解析，让 request.raw 保持为原始流
      bodyLimit: 1024 ** 3,
      preParsing: async (request, reply, payload) => {
        // 强制设置 content-type 避免 415 错误
        request.headers['content-type'] = 'application/octet-stream';
        return payload; // 返回原始流，不进行 JSON 解析
      }
    }, async (request, reply) => {
      const protocol = request.query.protocol ?? "result";
      const taskId = request.query.taskId;

      if (!taskId) {
        return reply.code(400).send({ error: "Missing taskId" });
      }

      // 改为 await 异步处理流
      const resolved = await this._resolvePipeWaiter(protocol, taskId, request);
      if (!resolved) {
        return reply.code(409).send({ error: "消费方不存在" });
      }

      // 流结束后返回成功
      return { status: "delivered" };
    });

    // 查询所有连接信息
    this.fastify.get("/pivots", async (_request, reply) => {
      const result = await this._handleBizMessage({
        senderId: "gateway",
        type: "pivots",
        payload: {},
        traceId: randomUUID(),
        timestamp: Date.now(),
      });
      return reply.code(200).send(result);
    });

  }

  private _pipeWaiterKey(protocol: string, taskId: string): string {
    return `${taskId}:${protocol}`;
  }

  private _setPipeWaiter(protocol: string, taskId: string, reply: FastifyReply): void {
    const key = this._pipeWaiterKey(protocol, taskId);
    const timer = setTimeout(() => {
      this.pipeWaiters.delete(key);
      if (!reply.sent) {
        reply.code(504).send({ error: "超时" });
      }
    }, this.requestTimeout);

    reply.raw.on("close", () => {
      clearTimeout(timer);
      this.pipeWaiters.delete(key);
    });

    this.pipeWaiters.set(key, { reply, timer });
  }

  private async _resolvePipeWaiter(
    protocol: string,
    taskId: string,
    request: FastifyRequest
  ): Promise<boolean> {
    const key = this._pipeWaiterKey(protocol, taskId);
    const waiter = this.pipeWaiters.get(key);

    if (!waiter) {
      console.log('[Gateway] 无等待者:', key);
      return false;
    }

    const targetRaw = waiter.reply.raw;  // GET 长轮询端
    const sourceRaw = request.raw;       // POST 上传端

    // 检查 GET 端是否还活着
    if (targetRaw.writableEnded || targetRaw.destroyed) {
      console.log('[Gateway] 目标连接已关闭');
      this.pipeWaiters.delete(key);
      return false;
    }

    // === 从 HTTP 头读取元数据（替代第一帧） ===
    const statusCode = parseInt(request.headers['x-pipe-status'] as string) || 200;
    let headers: Record<string, string> = {};
    try {
      const headerStr = request.headers['x-pipe-headers'] as string;
      if (headerStr) {
        headers = JSON.parse(headerStr);
      }
    } catch (e) {
      console.warn('[Gateway] 解析 headers 失败:', e);
    }

    console.log('[Gateway] 直接管道模式', {
      taskId,
      status: statusCode,
      sourceFlowing: sourceRaw.readableFlowing
    });

    // 劫持 GET 响应，手动写头
    waiter.reply.hijack();
    targetRaw.writeHead(statusCode, {
      ...headers,
      'Transfer-Encoding': 'chunked',
      'X-Pipe-Protocol': protocol,
      'X-Accel-Buffering': 'no'
    });

    // === 直接管道，零拷贝 ===
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.pipeWaiters.delete(key);
        success ? resolve(true) : reject(new Error('Stream failed'));
      };

      // 核心：sourceRaw (POST body) -> targetRaw (GET response)
      sourceRaw.pipe(targetRaw);

      // 源流结束（FakeAgent 调用 writer.close()）
      sourceRaw.on('end', () => {
        console.log('[Gateway] 源流结束，关闭目标');
        targetRaw.end();
        cleanup(true);
      });

      // 错误处理
      sourceRaw.on('error', (err) => {
        console.error('[Gateway] 源流错误:', err.message);
        targetRaw.destroy();
        cleanup(false);
      });

      targetRaw.on('error', (err) => {
        console.error('[Gateway] 目标流错误:', err.message);
        sourceRaw.destroy();
        cleanup(false);
      });

      // GET 客户端断开（浏览器关闭页面）
      targetRaw.on('close', () => {
        console.log('[Gateway] 目标关闭（客户端断开）');
        sourceRaw.destroy();
        cleanup(false);
      });

      // 长流传输超时保护（10 倍普通超时）
      waiter.timer = setTimeout(() => {
        console.error('[Gateway] 管道传输超时');
        sourceRaw.destroy();
        targetRaw.destroy();
        cleanup(false);
      }, this.requestTimeout * 10);
    });
  }
}

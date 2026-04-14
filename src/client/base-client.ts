import { WebSocket } from "ws";
import type { Message, PivotInfo, PivotType } from "../protocol/message.ts";

export interface BasePivotOptions {
  gatewayUrl: string;
  pivotId: string;
  type: PivotType;
  capabilities?: Record<string, unknown>;
  heartbeatInterval?: number;
  /** 使用 WebSocket 长连接，否则使用 HTTP 短连接 */
  useWebSocket?: boolean;
}

/**
 * 支点 SDK 基类
 * - 支持 HTTP 和 WebSocket 双模式
 * - 自动发送 register 和心跳（WS 模式下）
 * - 实现统一3接口：push / progress / result
 */
export abstract class BasePivot {
  protected options: BasePivotOptions;
  protected ws?: WebSocket;
  protected heartbeatTimer?: NodeJS.Timeout;
  protected pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  protected pendingStreams = new Map<string, ReadableStreamDefaultController<unknown>>();

  /**
   * 构造 BasePivot 实例
   * @param options - 支点配置（网关地址、ID、类型、能力、连接模式等）
   */
  constructor(options: BasePivotOptions) {
    this.options = {
      heartbeatInterval: 30_000,
      useWebSocket: true,
      ...options,
    };
  }

  /**
   * 建立与网关的连接（仅在 WebSocket 模式下有效）
   * - 将 http 协议头替换为 ws 后建立 WebSocket 连接
   * - 连接成功后自动发送注册消息并启动心跳
   * @returns Promise，连接成功时 resolve
   */
  async connect(): Promise<void> {
    if (!this.options.useWebSocket) return;

    return new Promise((resolve, reject) => {
      const wsUrl = this.options.gatewayUrl.replace(/^http/, "ws");
      this.ws = new WebSocket(wsUrl);

      this.ws.once("open", () => {
        this._sendRegister();
        this._startHeartbeat();
        resolve();
      });

      this.ws.once("error", reject);
      this.ws.on("message", (raw) => this._onMessage(raw));
      this.ws.on("close", () => this._stopHeartbeat());
    });
  }

  /**
   * 断开与网关的连接
   * - 停止心跳定时器
   * - 关闭 WebSocket
   */
  disconnect(): void {
    this._stopHeartbeat();
    this.ws?.close();
  }

  /**
   * 接收任务，立即确认（统一接口 1/3）
   * WS 模式下直接通过 socket 发送；HTTP 模式下调用 /push 接口
   * @param message - 要推送的 Message
   */
  async push(message: Message): Promise<void> {
    if (this.options.useWebSocket && this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    const res = await fetch(`${this.options.gatewayUrl}/push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`推送失败: ${res.status}`);
  }

  /**
   * 流式返回进度（统一接口 2/3）
   * WS 模式下通过内部 pendingStreams 匹配响应；HTTP 模式下直接拉取 /progress/:taskId
   * @param taskId - 任务唯一标识
   * @returns 可读流，用于实时读取进度数据
   */
  progress(taskId: string): ReadableStream<Uint8Array> {
    if (this.options.useWebSocket && this.ws?.readyState === 1) {
      return this._wsProgress(taskId);
    }
    return this._httpProgress(taskId);
  }

  /**
   * 返回最终结果（统一接口 3/3）
   * WS 模式下通过内部 pendingRequests 匹配响应；HTTP 模式下直接调用 /result/:taskId
   * @param taskId - 任务唯一标识
   * @returns 最终结果数据
   */
  async result(taskId: string): Promise<unknown> {
    if (this.options.useWebSocket && this.ws?.readyState === 1) {
      return this._wsResult(taskId);
    }
    const res = await fetch(`${this.options.gatewayUrl}/result/${taskId}`);
    if (!res.ok) throw new Error(`获取结果失败: ${res.status}`);
    const json = (await res.json()) as { data?: unknown; error?: string };
    if (json.error) throw new Error(json.error);
    return json.data;
  }

  // ─── WebSocket 内部方法 ───

  /**
   * 发送 register 消息到网关
   * - 携带 pivotId、type、capabilities
   */
  private _sendRegister(): void {
    const registerMsg: Message = {
      senderId: this.options.pivotId,
      type: "register",
      payload: {
        pivotId: this.options.pivotId,
        type: this.options.type,
        capabilities: this.options.capabilities,
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    };
    this.ws?.send(JSON.stringify(registerMsg));
  }

  /**
   * 启动心跳定时器
   * - 按配置间隔定期发送 heartbeat 消息
   */
  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const hb: Message = {
        senderId: this.options.pivotId,
        type: "heartbeat",
        payload: {},
        traceId: crypto.randomUUID(),
        timestamp: Date.now(),
      };
      this.ws?.send(JSON.stringify(hb));
    }, this.options.heartbeatInterval);
  }

  /**
   * 停止心跳定时器
   */
  private _stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /**
   * 处理 WebSocket 收到的消息
   * - 匹配 pendingReq / pendingStream
   * - 处理网关发来的 progress / result 查询请求
   * - 将 push 任务转交给子类 onTask
   * @param raw - WebSocket 原始消息数据
   */
  private _onMessage(raw: Buffer | ArrayBuffer | Buffer[]): void {
    try {
      const text = Array.isArray(raw) ? Buffer.concat(raw).toString() : raw.toString();
      const msg = JSON.parse(text) as Message;

      // 请求响应匹配
      const pendingReq = this.pendingRequests.get(msg.traceId);
      if (pendingReq) {
        this.pendingRequests.delete(msg.traceId);
        if (msg.payload?.error) pendingReq.reject(new Error(String(msg.payload.error)));
        else pendingReq.resolve(msg.payload?.data ?? msg.payload);
        return;
      }

      // 流式响应匹配
      const pendingStream = this.pendingStreams.get(msg.traceId);
      if (pendingStream) {
        if (msg.type === "progress") {
          pendingStream.enqueue(msg.payload?.data ?? msg.payload);
        } else if (msg.type === "result") {
          pendingStream.enqueue(msg.payload?.data ?? msg.payload);
          pendingStream.close();
          this.pendingStreams.delete(msg.traceId);
        }
        return;
      }

      // 处理网关发来的进度查询请求
      if (msg.type === "progress") {
        const taskId = msg.payload?.taskId as string;
        const stream = this.onProgressRequest?.(taskId);
        if (stream) {
          const reader = stream.getReader();
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                const response: Message = {
                  senderId: this.options.pivotId,
                  targetId: "gateway",
                  type: done ? "result" : "progress",
                  payload: { taskId, data: done ? undefined : value },
                  traceId: msg.traceId,
                  timestamp: Date.now(),
                };
                this.ws?.send(JSON.stringify(response));
                if (done) break;
              }
            } finally {
              reader.releaseLock();
            }
          };
          pump().catch(() => {
            // ignore
          });
        } else {
          const response: Message = {
            senderId: this.options.pivotId,
            targetId: "gateway",
            type: "result",
            payload: { taskId, data: null },
            traceId: msg.traceId,
            timestamp: Date.now(),
          };
          this.ws?.send(JSON.stringify(response));
        }
        return;
      }

      // 处理网关发来的结果查询请求
      if (msg.type === "result") {
        const taskId = msg.payload?.taskId as string;
        Promise.resolve(this.onResultRequest?.(taskId))
          .then((data) => {
            const response: Message = {
              senderId: this.options.pivotId,
              targetId: "gateway",
              type: "result",
              payload: { taskId, data },
              traceId: msg.traceId,
              timestamp: Date.now(),
            };
            this.ws?.send(JSON.stringify(response));
          })
          .catch((err) => {
            const response: Message = {
              senderId: this.options.pivotId,
              targetId: "gateway",
              type: "result",
              payload: { taskId, error: err instanceof Error ? err.message : String(err) },
              traceId: msg.traceId,
              timestamp: Date.now(),
            };
            this.ws?.send(JSON.stringify(response));
          });
        return;
      }

      // 普通任务推送：由子类处理
      if (msg.type === "push") {
        this.onTask(msg).catch(() => {
          // ignore
        });
      }
    } catch {
      // ignore invalid message
    }
  }

  /**
   * WebSocket 模式下请求流式进度
   * - 生成 traceId 并注册到 pendingStreams
   * - 向网关发送 progress 查询消息
   * @param taskId - 任务唯一标识
   * @returns 可读流
   */
  private _wsProgress(taskId: string): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const traceId = crypto.randomUUID();
        this.pendingStreams.set(traceId, controller as unknown as ReadableStreamDefaultController<unknown>);
        const msg: Message = {
          senderId: this.options.pivotId,
          type: "progress",
          payload: { taskId },
          traceId,
          timestamp: Date.now(),
        };
        this.ws?.send(JSON.stringify(msg));
      },
      cancel: () => {
        // 清理由 close 处理
      },
    });
  }

  /**
   * WebSocket 模式下请求最终结果
   * - 生成 traceId 并注册到 pendingRequests
   * - 向网关发送 result 查询消息
   * @param taskId - 任务唯一标识
   * @returns Promise<unknown>
   */
  private _wsResult(taskId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const traceId = crypto.randomUUID();
      this.pendingRequests.set(traceId, { resolve, reject });
      const msg: Message = {
        senderId: this.options.pivotId,
        type: "result",
        payload: { taskId },
        traceId,
        timestamp: Date.now(),
      };
      this.ws?.send(JSON.stringify(msg), (err) => {
        if (err) {
          this.pendingRequests.delete(traceId);
          reject(err);
        }
      });
    });
  }

  /**
   * HTTP 模式下请求流式进度
   * - 直接 fetch /progress/:taskId
   * - 将响应 body 转换为 ReadableStream 返回
   * @param taskId - 任务唯一标识
   * @returns 可读流
   */
  private _httpProgress(taskId: string): ReadableStream<Uint8Array> {
    const url = `${this.options.gatewayUrl}/progress/${taskId}`;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const res = await fetch(url);
        if (!res.ok) {
          controller.error(new Error(`进度请求失败: ${res.status}`));
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          reader.releaseLock();
        }
        controller.close();
      },
    });
  }

  /**
   * 通过 WebSocket 主动向网关发送消息
   * 供 Agent/工具/子网关等需要主动回传进度/结果时使用
   * @param message - 要发送的 Message
   * @throws WebSocket 未连接时抛出错误
   */
  send(message: Message): void {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(message));
    } else {
      throw new Error("WebSocket 未连接");
    }
  }

  /**
   * 子类可选实现：处理网关发来的进度查询请求
   * @param taskId - 任务唯一标识
   * @returns 进度数据流或 undefined
   */
  onProgressRequest?(taskId: string): ReadableStream<unknown> | undefined;

  /**
   * 子类可选实现：处理网关发来的结果查询请求
   * @param taskId - 任务唯一标识
   * @returns 结果数据或 Promise
   */
  onResultRequest?(taskId: string): unknown | Promise<unknown>;

  /**
   * 子类必须实现：处理网关推送过来的任务
   * @param message - 推送过来的 Message
   */
  abstract onTask(message: Message): Promise<void>;
}

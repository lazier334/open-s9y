import type { WebSocket } from "ws";
import type { FastifyReply } from "fastify";
import type { Message, PivotInfo, Status } from "../protocol/message.ts";

export interface Connection {
  socket?: WebSocket;
  reply?: FastifyReply;
  pivotInfo: PivotInfo;
  status: Status;
  heartbeatTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  /** HTTP 长轮询模式下无 socket */
  isHttp?: boolean;
  /** 统一发送消息接口，WS 与 HTTP 各自实现 */
  send: (message: Message, code?: number) => void;
}

export interface CachedPivot {
  pivotInfo: PivotInfo;
  status: Status;
  disconnectAt: number;
}

export interface ConnectionManagerOptions {
  heartbeatInterval?: number;
  pivotTimeout?: number;
  pivotCacheTTL?: number;
}

export type ConnectionEventHandler = {
  onConnect?: (pivotId: string, connection: Connection) => void;
  onDisconnect?: (pivotId: string) => void;
  onHeartbeatTimeout?: (pivotId: string) => void;
};

/**
 * 连接治理中心
 * - 管理活跃连接 Map（含 WS 和 HTTP 长轮询）
 * - 心跳检测与超时断开
 * - 断线缓存（pivotCache），重连时直接覆盖
 */
export class ConnectionManager {
  private connections = new Map<string, Connection>();
  private pivotCache = new Map<string, CachedPivot>();
  private heartbeatInterval: number;
  private pivotTimeout: number;
  private pivotCacheTTL: number;
  private handlers: ConnectionEventHandler;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options: ConnectionManagerOptions = {}, handlers: ConnectionEventHandler = {}) {
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.pivotTimeout = options.pivotTimeout ?? 60_000;
    this.pivotCacheTTL = options.pivotCacheTTL ?? 60_000;
    this.handlers = handlers;
    this.cleanupTimer = setInterval(() => this._cleanupCache(), this.pivotCacheTTL);
  }

  /**
   * 尝试注册连接（WS/HTTP 统一逻辑）
   * @returns { accepted, reason }
   * - accepted: 是否接受
   * - reason: 拒绝原因（如冲突）
   */
  tryRegister(pivotId: string): { accepted: boolean; reason?: string } {
    if (this.connections.has(pivotId)) {
      return { accepted: false, reason: "pivotId 已被占用" };
    }
    return { accepted: true };
  }

  /**
   * 添加新的支点 WS 连接
   */
  addWs(pivotId: string, pivotInfo: PivotInfo, socket: WebSocket): Connection {
    const now = Date.now();
    const cached = this.pivotCache.get(pivotId);
    const connection: Connection = {
      socket,
      pivotInfo,
      status: cached
        ? { ...cached.status, lastHeartbeatAt: now }
        : { connectedAt: now, lastHeartbeatAt: now },
      send: (message: Message) => {
        if (socket.readyState !== 1) {
          throw new Error("WebSocket 未连接");
        }
        socket.send(JSON.stringify(message));
      },
    };

    this.connections.set(pivotId, connection);
    console.log('WS 支点注册', pivotId);
    this._startTimers(pivotId, connection);
    this.handlers.onConnect?.(pivotId, connection);
    return connection;
  }

  /**
   * 添加新的 HTTP 长轮询连接
   * send 方法由 /register handler 在挂起时注入
   */
  addHttp(pivotId: string, pivotInfo: PivotInfo, reply: FastifyReply): Connection {
    const now = Date.now();
    const cached = this.pivotCache.get(pivotId);
    const connection: Connection = {
      reply,
      pivotInfo,
      status: cached
        ? { ...cached.status, lastHeartbeatAt: now }
        : { connectedAt: now, lastHeartbeatAt: now },
      isHttp: true,
      send: () => {
        throw new Error("HTTP 连接尚未就绪");
      },
    };

    this.connections.set(pivotId, connection);
    console.log('HTTP 支点注册', pivotId);
    this.handlers.onConnect?.(pivotId, connection);
    return connection;
  }

  /**
   * 获取指定支点的连接信息
   */
  get(pivotId: string): Connection | undefined {
    return this.connections.get(pivotId);
  }

  /**
   * 检查指定支点是否仍有活跃连接
   */
  has(pivotId: string): boolean {
    return this.connections.has(pivotId);
  }

  /**
   * 检查指定支点是否在线
   */
  isOnline(pivotId: string): boolean {
    return this.connections.has(pivotId);
  }

  /**
   * 移除 WS 连接
   */
  removeWs(pivotId: string): boolean {
    const connection = this.connections.get(pivotId);
    if (!connection || connection.isHttp) return false;

    this._cachePivot(pivotId, connection);
    this._clearTimers(connection);
    this.connections.delete(pivotId);
    console.info('WS 支点移除', pivotId);
    this.handlers.onDisconnect?.(pivotId);
    return true;
  }

  /**
   * 移除 HTTP 连接（长轮询断开）
   */
  removeHttp(pivotId: string, cache = true): boolean {
    const connection = this.connections.get(pivotId);
    if (!connection || !connection.isHttp) return false;

    if (cache) {
      this._cachePivot(pivotId, connection);
    }
    this.connections.delete(pivotId);
    console.info('HTTP 支点移除', pivotId);
    this.handlers.onDisconnect?.(pivotId);
    return true;
  }

  /**
   * 更新支点心跳时间
   */
  updateHeartbeat(pivotId: string): boolean {
    const connection = this.connections.get(pivotId);
    if (!connection) return false;

    connection.status.lastHeartbeatAt = Date.now();
    if (!connection.isHttp) {
      this._clearTimers(connection);
      this._startTimers(pivotId, connection);
    }
    return true;
  }

  /**
   * 获取所有活跃连接的副本
   */
  getAll(): Map<string, Connection> {
    return new Map(this.connections);
  }

  /**
   * 获取缓存
   */
  getCache(pivotId: string): CachedPivot | undefined {
    const cached = this.pivotCache.get(pivotId);
    if (cached && Date.now() - cached.disconnectAt > this.pivotCacheTTL) {
      this.pivotCache.delete(pivotId);
      return undefined;
    }
    return cached;
  }

  /**
   * 删除缓存
   */
  deleteCache(pivotId: string): boolean {
    return this.pivotCache.delete(pivotId);
  }

  /**
   * 为指定连接启动心跳和超时定时器（仅 WS）
   */
  private _startTimers(pivotId: string, connection: Connection): void {
    connection.heartbeatTimer = setInterval(() => {
      if (connection.socket?.readyState === 1) {
        connection.socket.ping();
      }
    }, this.heartbeatInterval);

    connection.timeoutTimer = setTimeout(() => {
      this.handlers.onHeartbeatTimeout?.(pivotId);
      this._destroy(connection);
      this._cachePivot(pivotId, connection);
      this.connections.delete(pivotId);
      this.handlers.onDisconnect?.(pivotId);
    }, this.pivotTimeout);
  }

  /**
   * 清理连接上的所有定时器
   */
  private _clearTimers(connection: Connection): void {
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = undefined;
    }
    if (connection.timeoutTimer) {
      clearTimeout(connection.timeoutTimer);
      connection.timeoutTimer = undefined;
    }
  }

  /**
   * 将连接信息缓存到 pivotCache
   */
  private _cachePivot(pivotId: string, connection: Connection): void {
    this.pivotCache.set(pivotId, {
      pivotInfo: connection.pivotInfo,
      status: connection.status,
      disconnectAt: Date.now(),
    });
  }

  /**
   * 清理过期缓存
   */
  private _cleanupCache(): void {
    const now = Date.now();
    for (const [pivotId, cached] of this.pivotCache.entries()) {
      if (now - cached.disconnectAt > this.pivotCacheTTL) {
        this.pivotCache.delete(pivotId);
      }
    }
  }

  /**
   * 关闭治理中心，清理所有资源
   */
  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    for (const connection of this.connections.values()) {
      this._destroy(connection);
    }
    this.connections.clear();
    this.pivotCache.clear();
  }

  /**
   * 强制销毁连接
   */
  private _destroy(connection: Connection): void {
    this._clearTimers(connection);
    try {
      connection.socket?.terminate();
    } catch {
      // ignore
    }
  }
}

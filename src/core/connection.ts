import type { WebSocket } from "ws";
import type { PivotInfo, Status } from "../protocol/message.ts";

export interface Connection {
  socket: WebSocket;
  pivotInfo: PivotInfo;
  status: Status;
  heartbeatTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
}

export interface ConnectionManagerOptions {
  heartbeatInterval?: number;
  pivotTimeout?: number;
}

export type ConnectionEventHandler = {
  onConnect?: (pivotId: string, connection: Connection) => void;
  onDisconnect?: (pivotId: string) => void;
  onHeartbeatTimeout?: (pivotId: string) => void;
};

/**
 * 连接治理中心
 * - 管理活跃连接 Map
 * - 心跳检测与超时断开
 * - 断开时保留路由表（由外部决定何时清理）
 */
export class ConnectionManager {
  private connections = new Map<string, Connection>();
  private heartbeatInterval: number;
  private pivotTimeout: number;
  private handlers: ConnectionEventHandler;

  /**
   * 构造 ConnectionManager 实例
   * @param options - 心跳间隔、超时时间等配置
   * @param handlers - 连接生命周期事件处理器
   */
  constructor(options: ConnectionManagerOptions = {}, handlers: ConnectionEventHandler = {}) {
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
    this.pivotTimeout = options.pivotTimeout ?? 60_000;
    this.handlers = handlers;
  }

  /**
   * 添加新的支点连接
   * @param pivotId - 支点唯一标识
   * @param socket - WebSocket 连接实例
   * @param pivotInfo - 支点信息（类型、能力等）
   * @returns 创建的 Connection 对象
   */
  add(pivotId: string, socket: WebSocket, pivotInfo: PivotInfo): Connection {
    const now = Date.now();
    const connection: Connection = {
      socket,
      pivotInfo,
      status: {
        connectedAt: now,
        lastHeartbeatAt: now,
      },
    };

    this.connections.set(pivotId, connection);
    this._startTimers(pivotId, connection);
    this.handlers.onConnect?.(pivotId, connection);
    return connection;
  }

  /**
   * 获取指定支点的连接信息
   * @param pivotId - 支点唯一标识
   * @returns Connection 对象或 undefined
   */
  get(pivotId: string): Connection | undefined {
    return this.connections.get(pivotId);
  }

  /**
   * 检查指定支点是否仍在连接池中
   * @param pivotId - 支点唯一标识
   * @returns 是否存在活跃连接
   */
  has(pivotId: string): boolean {
    return this.connections.has(pivotId);
  }

  /**
   * 移除指定支点的连接
   * - 清理定时器
   * - 触发 onDisconnect 回调
   * @param pivotId - 支点唯一标识
   * @returns 是否成功移除
   */
  remove(pivotId: string): boolean {
    const connection = this.connections.get(pivotId);
    if (!connection) return false;

    this._clearTimers(connection);
    this.connections.delete(pivotId);
    this.handlers.onDisconnect?.(pivotId);
    return true;
  }

  /**
   * 更新支点心跳时间
   * - 重置 lastHeartbeatAt
   * - 重启心跳和超时定时器
   * @param pivotId - 支点唯一标识
   * @returns 是否成功更新
   */
  updateHeartbeat(pivotId: string): boolean {
    const connection = this.connections.get(pivotId);
    if (!connection) return false;

    connection.status.lastHeartbeatAt = Date.now();
    this._clearTimers(connection);
    this._startTimers(pivotId, connection);
    return true;
  }

  /**
   * 获取所有活跃连接的副本
   * @returns 包含所有 Connection 的新 Map
   */
  getAll(): Map<string, Connection> {
    return new Map(this.connections);
  }

  /**
   * 为指定连接启动心跳和超时定时器
   * @param pivotId - 支点唯一标识
   * @param connection - 连接对象
   */
  private _startTimers(pivotId: string, connection: Connection): void {
    connection.heartbeatTimer = setInterval(() => {
      if (connection.socket.readyState === 1) {
        connection.socket.ping();
      }
    }, this.heartbeatInterval);

    connection.timeoutTimer = setTimeout(() => {
      this.handlers.onHeartbeatTimeout?.(pivotId);
      this._destroy(connection);
      this.connections.delete(pivotId);
      this.handlers.onDisconnect?.(pivotId);
    }, this.pivotTimeout);
  }

  /**
   * 清理连接上的所有定时器
   * @param connection - 连接对象
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
   * 强制销毁连接
   * - 清理定时器
   * - 调用 socket.terminate() 强制关闭
   * @param connection - 连接对象
   */
  private _destroy(connection: Connection): void {
    this._clearTimers(connection);
    try {
      connection.socket.terminate();
    } catch {
      // ignore
    }
  }
}

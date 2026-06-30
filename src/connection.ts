import type { Message, PivotInfo, Status } from "../sdk/type.ts";
import { randomUUID } from "node:crypto";

/** 适配器类型 */
export type AdapterType = "ws" | "http" | "fun";

/**
 * 支点连接
 * - send: 统一的消息发送接口，返回 Promise 支持同步等待响应
 * - disconnectAt: 有值表示已断连，用于缓存 TTL 判断
 */
export interface Connection {
    pivotId: string;
    pivotInfo: PivotInfo;
    /** 状态 */
    status: Status;
    /** 适配器类型标识 */
    adapterType: AdapterType;
    /** 发送消息并等待响应（fun 模式可同步返回，ws/http 异步响应） */
    send: (message: Message) => Promise<unknown>;
    /** 断连时间戳，有值表示已断连（缓存状态） */
    disconnectAt?: number;
    /** 心跳定时器 */
    heartbeatTimer?: NodeJS.Timeout;
    /** 超时定时器 */
    timeoutTimer?: NodeJS.Timeout;
}

/** 连接管理器配置 */
export interface ConnectionManagerOptions {
    /** 心跳检测间隔（ms），定时向支点发送心跳消息 */
    heartbeatInterval?: number;
    /** 支点超时时间（ms），超时未收到心跳则视为离线并断开 */
    pivotTimeout?: number;
    /** 断连缓存保留时间（ms），超时后自动清理 */
    pivotCacheTTL?: number;
}

/** 连接事件回调 */
export type ConnectionEventHandler = {
    /** 支点连接建立时触发 */
    onConnect?: (pivotId: string, connection: Connection) => void;
    /** 支点断开连接时触发 */
    onDisconnect?: (pivotId: string) => void;
    /** 心跳超时（支点无响应）时触发，随后自动断开连接 */
    onHeartbeatTimeout?: (pivotId: string) => void;
};

/**
 * 统一支点管理器
 * - 管理所有类型的支点连接（WS / HTTP / Fun / 未来新协议）
 * - 心跳检测与超时断开
 * - 断线缓存：断连时保留 pivotInfo，重连时恢复状态
 * - 任务路由表（taskId → pivotId），断连自动清理
 */
export class ConnectionManager {
    // 任务路由表
    private taskRoutes = new Map<string, string>();
    private connections = new Map<string, Connection>();
    private heartbeatInterval: number;
    private pivotTimeout: number;
    private pivotCacheTTL: number;
    private handlers: ConnectionEventHandler;
    /** 定时清理过期缓存（兜底，防止内存泄漏） */
    private cleanupTimer?: NodeJS.Timeout;

    constructor(options: ConnectionManagerOptions = {}, handlers: ConnectionEventHandler = {}) {
        this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
        this.pivotTimeout = options.pivotTimeout ?? 60_000;
        this.pivotCacheTTL = options.pivotCacheTTL ?? 60_000;
        this.handlers = handlers;
        this.cleanupTimer = setInterval(() => this._cleanupExpiredCache(), this.pivotCacheTTL);
    }

    // #region 任务路由
    // ─── 任务路由 ───

    /** 记录任务到支点的路由映射 */
    setRoute(taskId: string, pivotId: string): void {
        this.taskRoutes.set(taskId, pivotId);
    }

    /** 根据任务 ID 查询负责处理的支点 ID */
    getPivotId(taskId: string): string | undefined {
        return this.taskRoutes.get(taskId);
    }

    /** 删除指定任务的路由记录 */
    removeRoute(taskId: string): boolean {
        return this.taskRoutes.delete(taskId);
    }

    /** 检查指定任务是否存在路由记录 */
    hasRoute(taskId: string): boolean {
        return this.taskRoutes.has(taskId);
    }

    /** 批量删除指定支点负责的所有任务路由 */
    removePivotRoutes(pivotId: string): number {
        let count = 0;
        for (const [taskId, cid] of this.taskRoutes.entries()) {
            if (cid === pivotId) {
                this.taskRoutes.delete(taskId);
                count++;
            }
        }
        return count;
    }

    // #endregion 任务路由
    // #region 连接管理
    // ─── 连接管理 ───

    /** 尝试注册支点 */
    tryRegister(pivotId: string): { accepted: boolean; reason?: string } {
        if (this.connections.has(pivotId)) {
            return { accepted: false, reason: "pivotId 已被占用" };
        }
        return { accepted: true };
    }

    /**
     * 添加支点连接（重连时复用已有对象）
     * @param pivotId 支点 ID
     * @param pivotInfo 支点信息
     * @param send 消息发送函数（适配器实现），返回 Promise<unknown>
     * @param adapterType 适配器类型标识
     * @param options 可选配置（心跳定时器等）
     */
    async addConnection(
        pivotId: string,
        pivotInfo: PivotInfo,
        send: (message: Message) => Promise<unknown>,
        adapterType: AdapterType,
        options?: { enableHeartbeat?: boolean }
    ): Promise<Connection> {
        let connection = this.connections.get(pivotId);
        if (!connection) connection = {} as Connection;

        // 更新字段
        connection.send = send;
        connection.pivotId = pivotId;
        connection.pivotInfo = pivotInfo;
        connection.adapterType = adapterType;
        connection.status = { connectedAt: Date.now(), lastHeartbeatAt: Date.now() };
        connection.disconnectAt = undefined;

        this.connections.set(pivotId, connection);
        console.info('支点注册', pivotId);
        if (options?.enableHeartbeat) {
            this._startTimers(pivotId, connection);
        }

        this.handlers.onConnect?.(pivotId, connection);
        return connection;
    }

    /** 移除支点连接, 保留缓存信息供重连恢复 */
    removeConnection(pivotId: string): boolean {
        const connection = this.connections.get(pivotId);
        if (!connection) return false;

        console.info('支点移除', pivotId);
        this._clearTimers(connection);
        // 标记为断连，保留 pivotInfo 和 status
        connection.disconnectAt = Date.now();
        this.removePivotRoutes(pivotId);
        this.handlers.onDisconnect?.(pivotId);
        return true;
    }

    /**
     * 获取支点连接
     * - 活跃连接：直接返回
     * - 过期缓存：自动清理并返回 undefined
     */
    get(pivotId: string): Connection | undefined {
        const conn = this.connections.get(pivotId);
        if (this._cleanConnection(conn)) return undefined;
        return conn;
    }

    /** 检查指定支点是否存在 */
    has(pivotId: string): boolean {
        const conn = this.connections.get(pivotId);
        return !!(conn && !this._cleanConnection(conn));
    }

    /** 获取所有活跃连接的副本 */
    getAll(): Map<string, Connection> {
        const result = this.getAllWithCache();
        for (const [pivotId, conn] of result) {
            if (!this._isExpired(conn)) {
                result.delete(pivotId);
            }
        }
        return result;
    }

    /** 获取所有未过期的连接副本 */
    getAllWithCache(): Map<string, Connection> {
        const result = new Map<string, Connection>();
        for (const [pivotId, conn] of this.connections) {
            if (!this._cleanConnection(conn)) {
                result.set(pivotId, conn);
            }
        }
        return result;
    }

    /** 更新心跳 */
    updateHeartbeat(pivotId: string): boolean {
        const connection = this.connections.get(pivotId);
        if (!connection || this._isExpired(connection)) return false;

        connection.status.lastHeartbeatAt = Date.now();
        if (connection.timeoutTimer) {
            this._clearTimers(connection);
            this._startTimers(pivotId, connection);
        }
        return true;
    }

    // #endregion 连接管理
    // #region 认证和其他方法
    // ─── 认证 ───

    /** 网络认证：验证请求 */
    async authenticateRequest(request: unknown): Promise<unknown> {
        const auditPivotId = process.env.AUDIT_PIVOT_ID ?? "audit";
        const auditConn = this.get(auditPivotId);
        if (auditConn) {
            const message: Message = {
                senderId: "gateway",
                targetId: auditPivotId,
                type: "authenticateRequest",
                payload: { data: { request } },
                traceId: randomUUID(),
                timestamp: Date.now(),
            };
            return await auditConn.send(message);
        }
        return true;
    }

    /** 审查连接是否有效 */
    async auditConnection(connection: Connection, request: unknown): Promise<unknown> {
        const auditPivotId = process.env.AUDIT_PIVOT_ID ?? "audit";
        const auditConn = this.get(auditPivotId);
        if (auditConn) {
            const message: Message = {
                senderId: "gateway",
                targetId: auditPivotId,
                type: "auditConnection",
                payload: { data: { connection, request } },
                traceId: randomUUID(),
                timestamp: Date.now(),
            };
            return await auditConn.send(message);
        }
    }

    // ─── 内部方法 ───

    /** 为指定连接启动心跳和超时定时器 */
    private _startTimers(pivotId: string, connection: Connection): void {
        connection.heartbeatTimer = setInterval(() => {
            // 心跳检测：调用 send 发送心跳消息
            connection.send({
                senderId: "gateway",
                targetId: pivotId,
                type: "heartbeat",
                payload: {},
                traceId: randomUUID(),
                timestamp: Date.now(),
            }).catch(() => { });
        }, this.heartbeatInterval);

        connection.timeoutTimer = setTimeout(() => {
            this.handlers.onHeartbeatTimeout?.(pivotId);
            this.removeConnection(pivotId);
        }, this.pivotTimeout);
    }

    /** 清理连接上的所有定时器 */
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

    /** 判断连接是否已过期（断连 + 超过 TTL） */
    private _isExpired(conn: Connection): boolean {
        if (conn.disconnectAt === undefined) return false;
        return Date.now() - conn.disconnectAt > this.pivotCacheTTL;
    }

    /** 定时清理过期缓存（兜底） */
    private _cleanupExpiredCache(): void {
        for (const [_pivotId, conn] of this.connections) {
            this._cleanConnection(conn)
        }
    }

    /** 清理过期的连接 */
    private _cleanConnection(conn: Connection | any): boolean {
        return conn && this._isExpired(conn) ? this.connections.delete(conn.pivotId) : false;
    }

    /** 关闭管理器，清理所有资源 */
    close(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        for (const connection of this.connections.values()) {
            this._clearTimers(connection);
        }
        this.connections.clear();
        this.taskRoutes.clear();
    }
    // #endregion 认证和其他方法
}

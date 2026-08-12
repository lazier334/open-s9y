import type { FunAdapter } from "./adapters/fun-adapter.ts"
import type { Pivot, FunPivot } from "../sdk/fun-pivot-sdk.ts";
import { Message, MessagePayload, debug } from "../sdk/type.ts";

/** 适配器类型 */
export type AdapterType = "ws" | "http" | "fun" | string;

/**
 * 支点连接
 * - send: 统一的消息发送接口，返回 Promise 支持同步等待响应
 * - disconnectAt: 有值表示已断连，用于缓存 TTL 判断
 */
export interface Connection {
    pivotId: string;
    pivotInfo: Pivot;
    /** 适配器类型标识 */
    adapterType: AdapterType;
    /** 发送消息并等待响应（fun 模式可同步返回，ws/http 异步响应） */
    send: (message: Message) => Promise<unknown>;
    /** 断连时间戳，有值表示已断连（缓存状态） */
    disconnectAt?: number;
    /** 连接建立时间（ms） */
    connectedAt: number;
    /** 最后一次心跳时间（ms） */
    lastHeartbeatAt: number;
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
    /** 路由解析支点id */
    pluginPivotId?: string;
    /** 消息发送超时（ms），当目标支点不在线的时候等待 */
    waitSendTimeout?: number;
    gatewayPivot?: FunPivot;
}

/**
 * 统一支点管理器
 * - 管理所有类型的支点连接（WS / HTTP / Fun / 未来新协议）
 * - 心跳检测与超时断开
 * - 断线缓存：断连时保留 Pivot，重连时恢复状态
 * - 任务路由表（taskId → pivotId），断连自动清理
 */
export class ConnectionManager {
    private gatewayPivot: FunPivot;
    async setFunAdapter(funAdapter: FunAdapter) {
        this.gatewayPivot.funAdapter = funAdapter;
        await this.gatewayPivot.connect();
    }
    // 任务路由表
    private taskRoutes = new Map<string, string>();
    private connections = new Map<string, Connection>();
    private heartbeatInterval: number;
    private pivotTimeout: number;
    private pivotCacheTTL: number;
    /** 定时清理过期缓存（兜底，防止内存泄漏） */
    private cleanupTimer?: NodeJS.Timeout;
    private pluginPivotId?: string;
    private waitSends: Record<string, ({
        message: Message,
        routeTo: (conn: Connection) => Promise<void>,
        waitTime: number,
        resolve: (value: unknown) => void,
        reject: (reason?: any) => void
    })[]> = {};
    private waitSendTimeout: number;

    /** 构造函数 */
    constructor(options: ConnectionManagerOptions = {}) {
        this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
        this.pivotTimeout = options.pivotTimeout ?? 60_000;
        this.pivotCacheTTL = options.pivotCacheTTL ?? 60_000;
        this.pluginPivotId = options.pluginPivotId;
        this.waitSendTimeout = options.waitSendTimeout ?? 30_000;
        if (typeof options.gatewayPivot != 'object') throw new Error('必须提供有效的 gatewayPivot 参数!');
        this.gatewayPivot = options.gatewayPivot;
        this.cleanupTimer = setInterval(() => this._cleanupExpiredCache(), this.pivotCacheTTL);
    }

    /** 关闭管理器，清理所有资源 */
    close(): void {
        // 清理等待发送的消息
        Object.values(this.waitSends).forEach(waitSend => {
            waitSend.forEach(wait => wait.reject(new Error("s9y正在关闭")))
        });
        // 清理定时器
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        // 清理连接的定时器
        for (const connection of this.connections.values()) {
            this._clearTimers(connection);
        }
        // 清理连接和路由
        this.connections.clear();
        this.taskRoutes.clear();
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
        if (typeof pivotId != 'string' || !pivotId) return { accepted: false, reason: `pivotId 不合法,他不是字符串或为假: "${pivotId}"` };
        const conn = this.connections.get(pivotId);
        if (conn && conn.disconnectAt === undefined) {
            return { accepted: false, reason: `pivotId 已被占用: "${pivotId}"` };
        }
        return { accepted: true };
    }

    /**
     * 添加支点连接（重连时复用已有对象）  
     * 由于重连时复用已有对象，所以可能会被攻击的方式:  
     * 1. 先发送一个请求，将这个支点打下线（http模式接入时）  
     * 2. 伪造这个支点接入系统  
     * 3. 接收其他支点发送过来的任务并返回伪造的结果  
     * 目前不对这种攻击方式做处理，可以通过增强验证系统+隔离接入来源来完成安全措施。更好的安全机制还在研究中
     * @param pivotId 支点 ID
     * @param pivotInfo 支点信息
     * @param send 消息发送函数（适配器实现），返回 Promise<unknown>
     * @param adapterType 适配器类型标识
     * @param options 可选配置（心跳定时器等）
     */
    async addConnection(
        pivotId: string,
        pivotInfo: Pivot,
        send: (message: Message) => Promise<unknown>,
        adapterType: AdapterType,
    ): Promise<Connection> {
        let connection = this.connections.get(pivotId);
        if (!connection) connection = {} as Connection;

        // 更新字段
        connection.send = send;
        connection.pivotId = pivotId;
        connection.pivotInfo = pivotInfo;
        connection.adapterType = adapterType;
        connection.connectedAt = Date.now();
        connection.lastHeartbeatAt = Date.now();
        connection.disconnectAt = undefined;

        this.connections.set(pivotId, connection);
        console.info('支点注册', pivotId);

        // 连接已注册，检查是否有待发送的消息
        if (Array.isArray(this.waitSends[pivotId]) && 0 < this.waitSends[pivotId].length) {
            // 循环发送消息，为了避免http这种单次只能接收一条消息，所以需要等待对方接收完成并且每次都需要检查连接是否还在
            for (let i = 0; i < this.waitSends[pivotId].length; i++) {
                const message = this.waitSends[pivotId][i];
                try {
                    if (Date.now() - this.waitSendTimeout < message.waitTime) {
                        await message.routeTo(connection);
                    } else {
                        console.log('删除等待发送超时的消息!', message);
                    }
                    // 发送成功或者超时都删除该任务
                    this.waitSends[pivotId].splice(i, 1);
                } catch (err) {
                    // 如果任务还没有超时就无限重试，这样就不用处理网络异常问题了
                    const errMsg = err instanceof Error ? err.message : String(err);
                    console.log('挂起的消息尝试发送失败, 等待下次尝试', errMsg)
                }
            }
        }
        return connection;
    }

    /** 移除支点连接, 保留缓存信息供重连恢复 */
    removeConnection(pivotId: string): boolean {
        const connection = this.connections.get(pivotId);
        if (!connection) return false;

        console.warn('支点移除', pivotId);
        this._clearTimers(connection);
        // 标记为断连，保留 pivotInfo 和 status
        connection.disconnectAt = Date.now();
        this.removePivotRoutes(pivotId);
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
            if (this._isExpired(conn)) {
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

        connection.lastHeartbeatAt = Date.now();
        if (connection.timeoutTimer) {
            this._clearTimers(connection);
            // this._startTimers(pivotId, connection);
        }
        return true;
    }

    // #endregion 连接管理
    // #region 认证和其他方法
    // ─── 认证 ───

    /** 接入认证：验证请求 */
    async authenticateRequest(request: unknown): Promise<boolean> {
        const auditPivotId = process.env.AUDIT_PIVOT_ID ?? "audit";
        const auditConn = this.get(auditPivotId);
        if (auditConn) {
            const message = new Message({
                receiverId: auditPivotId,
                payload: {
                    type: "authenticateRequest",
                    timestamp: Date.now(),
                    sync: true
                },
                body: { request }
            });
            const reMsg = await this.gatewayPivot.sendToServer(message) as Message;
            return typeof reMsg?.body == 'object' && reMsg.body != null;
        }
        return false;
    }

    /** 审查连接是否有效 */
    async auditConnection(connection: Connection, request: unknown): Promise<unknown> {
        const auditPivotId = process.env.AUDIT_PIVOT_ID ?? "audit";
        const auditConn = this.get(auditPivotId);
        if (auditConn) {
            const message = new Message({
                receiverId: auditPivotId,
                payload: {
                    type: "auditConnection",
                    timestamp: Date.now(),
                    sync: true
                },
                body: { connection, request }
            });
            return await this.gatewayPivot.sendToServer(message) as Message;
        }
    }

    // ─── 内部方法 ───

    /** 为指定连接启动心跳和超时定时器
     * @deprecated 服务器不应该主动给客户端发心跳
     */
    private _startTimers(pivotId: string, connection: Connection): void {
        connection.heartbeatTimer = setInterval(() => {
            // 心跳检测：调用 send 发送心跳消息
            this.gatewayPivot.sendToServer(new Message({
                receiverId: pivotId,
                payload: {
                    type: "heartbeat",
                    timestamp: Date.now()
                }
            })).catch(err => { });
        }, this.heartbeatInterval);

        connection.timeoutTimer = setTimeout(() => {
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

    // #endregion 认证和其他方法
    // #region 统一发送消息

    /**
     * 解析目标支点 ID
     * - 消息已有 receiverId 则直接使用
     * - 否则通过插件 pivot（router）动态路由
     */
    async selectTargetPivotId(message: Message): Promise<string> {
        if (message.receiverId) return message.receiverId;
        if (!this.pluginPivotId) throw new Error("未配置路由插件 pivot");

        const pluginMsg = new Message({
            receiverId: this.pluginPivotId,
            // 用于全局追踪，taskId 需要重新生成，因为他不是这一轮次消息的id
            traceId: message.traceId,
            payload: {
                ...message.payload,
                type: "push",
                timestamp: Date.now(),
                sync: true
            }
        });
        const msg = await this.gatewayPivot.sendToServer(pluginMsg) as Message;
        return msg.body
    }

    /**
     * 向指定支点请求并等待响应
     * - Fun 模式：直接调用 send，同步返回结果
     * - WS/HTTP 模式：通过 pendingRequests 等待异步响应
     */
    async requestTo(pivotId: string, message: Message): Promise<unknown> {
        debug('所有连接:', this.connections.size, Array.from(this.connections.keys()))
        const conn = this.get(pivotId);
        if (conn) {
            // 统一使用 send 方法，支持同步返回结果
            // 如果发送失败则放到下方异步等待发送结果
            try {
                return await conn.send(message);
            } catch (err) {
                console.warn('进入等待, 因为发送失败', err);
            }
        } else console.log(pivotId, '进入等待, 因为连接不存在');

        // 连接不存在或首次发送失败时，进入等待连接建立后重试
        return new Promise((resolve, reject) => {
            // 如果不存在则创建一个空数组
            if (!this.waitSends[pivotId]) {
                this.waitSends[pivotId] = [];
            }
            // 添加等待发送的任务
            this.waitSends[pivotId].push({
                waitTime: Date.now(),
                message,
                resolve,
                reject,
                async routeTo(conn: Connection) {
                    // 因为有可能是连接有异常导致发送失败，所以不能在这里忽略失败信息，应当将失败信息传出
                    return await conn.send(this.message).then(re => resolve(re));
                }
            });
        });
    }

    /**
     * 统一处理业务消息钩子，专门用于给外部重写，从而实现自定义消息处理机制
     * @returns 发送消息，返回发送结果，sync同步状态下返回目标结果
     */
    async handleBizMessageHook(message: Message): Promise<unknown> {
        return this.handleBizMessage(message)
    }

    /**
     * 统一处理业务消息
     * @returns 发送消息，返回发送结果，sync同步状态下返回目标结果
     */
    async handleBizMessage(message: Message): Promise<unknown> {
        try {
            debug('connection收到消息:', message)
            // 查询处理这个任务的支点然后进行响应
            const targetPivotId = await this.selectTargetPivotId(message);
            message.receiverId = targetPivotId;
            console.info('✉', message.senderId, '->', message.receiverId, message);
            // 记录目标路由表
            if (message.payload?.taskId) {
                this.setRoute(message.taskId, targetPivotId);
            }
            if (message.payload?.sync) {
                // 同步进行响应
                return await this.requestTo(targetPivotId, message);
            } else {
                // 异步进行响应
                this.requestTo(targetPivotId, message).catch(err => {
                    // 因为下方已经return，导致已经被响应过一次
                    // 所以此时只能做失败通知
                    console.error('x✉', message.senderId, '->', message.receiverId, err);
                    this.gatewayPivot.sendToServer(new Message({
                        ...message,
                        receiverId: message.senderId,
                        payload: new MessagePayload({
                            ...message.payload,
                            type: 'error'
                        })
                    })).catch(e => {
                        // NOTE 网关发送消息给源头失败，此时为双方均异常时，丢弃错误信息
                    });
                });
                return { status: "accepted", taskId: message.payload?.taskId };
            }
        } catch (err) {
            console.error('x✉', message.senderId, '->', message.receiverId, err);
            const errorMsg = err instanceof Error ? err.message : String(err);
            return { status: "error", taskId: message.payload?.taskId, error: errorMsg };
        }
    }
    // #endregion 统一发送消息
}

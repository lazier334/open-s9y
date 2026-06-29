import type { FastifyInstance, FastifyReply } from "fastify";
import type { Message, GatewayAPI } from "../sdk/type.ts";
import type { Server } from "node:http";
import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { ConnectionManager } from "./connection.ts";

/** 待响应的请求类型 */
type PendingRequest = {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
};

export interface GatewayServerOptions {
    port?: number;
    /** 心跳检测间隔（ms），超时未收到心跳则断开连接 */
    heartbeatInterval?: number;
    /** 支点超时时间（ms），超时未收到心跳则视为离线 */
    pivotTimeout?: number;
    /** 请求响应超时时间（ms） */
    requestTimeout?: number;
    /** 支点断连后缓存保留时间（ms），用于重连时恢复状态 */
    pivotCacheTTL?: number;
    /** 路由插件的 pivotId，用于动态路由解析 */
    pluginPivotId?: string;
}

/**
 * 网关服务器主类
 *
 * 职责：
 * - 管理 HTTP + WebSocket 双协议服务器生命周期
 * - 协议处理委托给适配器（HttpAdapter / WsAdapter / FunAdapter）
 * - 连接治理通过 ConnectionManager 统一管理
 * - GatewayAPI 实现：routeTo / requestTo / handleBizMessage
 */
export class GatewayServer implements GatewayAPI {
    // #region 网关类
    fastify: FastifyInstance;
    wss: WebSocketServer;
    connections: ConnectionManager;
    pluginPivotId?: string;

    /** 待响应的请求，key 为 traceId */
    readonly pendingRequests = new Map<string, PendingRequest>();
    /** 已完成的 taskId 集合，用于去重 */
    readonly completedTasks = new Set<string>();
    /** 请求响应超时时间（ms） */
    readonly requestTimeout: number;
    /** 服务器关闭时执行的回调函数列表 */
    closeHandlers: Array<() => void | Promise<void>> = [];

    constructor(options: GatewayServerOptions = {}) {
        this.fastify = Fastify({ logger: false });
        this.wss = new WebSocketServer({ server: this.fastify.server as Server });
        this.requestTimeout = options.requestTimeout ?? 30_000;
        this.pluginPivotId = options.pluginPivotId;

        // 注册 octet-stream 解析器，用于接收二进制流数据
        this.fastify.addContentTypeParser(
            "application/octet-stream",
            (_request, payload, done) => done(null, payload)
        );

        this.connections = new ConnectionManager({
            heartbeatInterval: options.heartbeatInterval,
            pivotTimeout: options.pivotTimeout,
            pivotCacheTTL: options.pivotCacheTTL,
        });
    }

    /**
     * 启动服务器监听
     * @param port 监听端口，端口被占用时自动重试（最多 5 次）
     * @returns 监听地址
     */
    async listen(port?: number): Promise<string> {
        const maxRetries = 5;
        const isAddressUseError = (err: Error | unknown) => err instanceof Error && err?.message?.startsWith('listen EADDRINUSE: address already in use');

        this.wss.on('error', (err) => {
            if (!isAddressUseError(err)) throw err;
        });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.fastify.listen({ port: port, host: "0.0.0.0" });
            } catch (err) {
                if (isAddressUseError(err)) {
                    if (attempt < maxRetries) {
                        console.warn(`端口 ${port} 被占用, 1秒后重试 (${attempt}/${maxRetries})...`);
                        await new Promise((r) => setTimeout(r, 1000));
                        continue;
                    }
                }
                throw err;
            }
        }
        throw new Error(`端口 ${port} 启动失败`);
    }

    /** 注册关闭回调，在服务器关闭时按注册顺序执行 */
    onClose(handler: () => void | Promise<void>): void {
        this.closeHandlers.push(handler);
    }

    /** 关闭服务器，依次清理回调、待处理请求、连接和协议服务器 */
    async close(): Promise<void> {
        for (const handler of this.closeHandlers) {
            await handler();
        }
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

    // #endregion 网关类
    // #region 接口实现
    // ─── GatewayAPI 实现 ───

    /**
     * 向指定支点发送消息
     * - 本地支点直接调用 onTask
     * - 远程支点通过连接发送，连接未就绪时自动重试（最多 5 秒）
     */
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
                console.error("消息发送失败, 准备重试:", err);
                return false;
            }
        };

        if (trySend()) return;

        // 连接未就绪时轮询重试
        const MAX_WAIT = 5000;
        const INTERVAL = 500;
        const start = Date.now();

        while (Date.now() - start < MAX_WAIT) {
            await new Promise((r) => setTimeout(r, INTERVAL));
            if (trySend()) return;
        }

        throw new Error(`支点离线: ${pivotId}`);
    }

    /** 流式请求（预留接口） */
    openStream(_pivotId: string, _message: Message): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
            start: (controller) => {
                controller.close();
            },
        });
    }

    /**
     * 向指定支点请求并等待响应
     * - 本地支点直接调用 onTask 返回结果
     * - 远程支点通过 pendingRequests 等待异步响应
     */
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

    // ─── 业务消息处理（委托给 MessageHandler） ───

    /**
     * 统一处理业务消息
     * - pivots 类型：查询支点列表
     * - 其他类型：路由到目标支点处理
     * @returns pivots 查询返回支点列表，其他返回路由结果
     */
    async handleBizMessage(message: Message): Promise<unknown> {
        if (message.type === "pivots") {
            const required = message.payload?.capabilities ?? [];
            const all = this.connections.getAll();
            const remote = Array.from(all.entries())
                .filter(([_, conn]) => required.length === 0 || required.every((c: string) => conn.pivotInfo.capabilities?.includes(c)))
                .map(([pid, conn]) => ({
                    pivotId: pid,
                    type: conn.pivotInfo.type,
                    name: conn.pivotInfo.name,
                    capabilities: conn.pivotInfo.capabilities,
                    adapterType: conn.socket ? "ws" as const : "http" as const,
                    status: conn.status,
                }));
            const local = this.connections.getLocalPivotsInfo()
                .filter((p) => required.length === 0 || required.every((c: string) => p.capabilities?.includes(c)))
                .map((p) => ({
                    ...p,
                    adapterType: "fun" as const,
                }));
            return { pivots: [...remote, ...local] };
        }

        const targetPivotId = await this._resolveTargetPivotId(message);
        message.targetId = targetPivotId;
        console.info('✉', message);

        if (message.payload?.sync) {
            const response = await this.requestTo(targetPivotId, message);
            if (message.payload?.taskId) {
                this.connections.setRoute(message.payload.taskId, targetPivotId);
            }
            return response;
        }

        await this.routeTo(targetPivotId, message);
        if (message.payload?.taskId) {
            this.connections.setRoute(message.payload.taskId, targetPivotId);
        }
        return { status: "accepted", taskId: message.payload?.taskId };
    }

    /**
     * 解析目标支点 ID
     * - 消息已有 targetId 则直接使用
     * - 否则通过插件 pivot（router）动态路由
     */
    private async _resolveTargetPivotId(message: Message): Promise<string> {
        if (message.targetId) return message.targetId;
        if (!this.pluginPivotId) throw new Error("未配置插件 pivot");

        const pluginMsg: Message = {
            senderId: "gateway",
            targetId: this.pluginPivotId,
            type: "push",
            payload: message.payload,
            traceId: crypto.randomUUID(),
            timestamp: Date.now(),
        };
        return (await this.requestTo(this.pluginPivotId, pluginMsg)) as string;
    }
    // #endregion 接口实现
}

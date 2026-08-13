/**
 * S9y SDK - 支点通信基类
 *
 * 设计原则：
 * - 基类负责消息发送/接收/匹配的核心逻辑
 * - 子类通过 override 处理具体协议的消息通道方法和消息分发
 */
import type { PivotOptions, MessageOptions } from './s9y-type.ts';
import { Pivot, Message, debug } from './s9y-type.ts';
export * from './s9y-type.ts';

// #region 类型定义

/** 支点连接状态 */
export interface Status {
    /** 连接建立时间（ms） */
    connectedAt: number;
    /** 最后一次心跳时间（ms） */
    lastHeartbeatAt: number;
    /** 负载值（预留，用于负载均衡） */
    load?: number;
}

/** 待响应的请求 */
interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timer: NodeJS.Timeout;
}

// #endregion 类型定义
// #region SDK基类

export type S9yPivotOptions = PivotOptions & {
    /** 请求超时时间 */
    requestTimeout?: number;
    /** 收到对方主动推送的消息，子类按需 override */
    onMessage?: (message: Message) => Promise<Message | void>
};
export abstract class S9yPivot extends Pivot {
    /** 请求超时时间 */
    readonly requestTimeout: number;

    protected pendingRequests = new Map<string, PendingRequest>();
    protected connected = false;

    constructor(pivot: S9yPivotOptions) {
        super(pivot);
        if (pivot.onMessage) this.onMessage = pivot.onMessage;
        this.requestTimeout = pivot.requestTimeout ?? 30_000;
    }

    // ─── 子类必须实现的方法 ───
    /** 发送原始消息（由具体协议实现，可返回响应数据） */
    protected abstract onSend(message: Message): Promise<unknown> | undefined;

    // ─── 子类可选 override ───
    /** 收到对方主动推送的消息，子类按需 override */
    protected async onMessage(message: Message): Promise<Message | void> { }
    /** 建立连接的方法 */
    protected async onConnect() { }
    /** 断开连接的方法 */
    protected async onDisconnect() { }

    // ─── 公共接口 ───

    /** 
     * pivot主动连接到网关
     */
    async connect(): Promise<void> {
        await this.onConnect();
        this.connected = true;
    }

    /** 
     * pivot主动断开连接
     */
    async disconnect(): Promise<void> {
        await this.onDisconnect();
        this.connected = false;
        this._rejectAllPending("SDK 已断开连接");
    }

    /** 基于Message对象创建挂起id */
    private createAutoReceiverIdByMessage(message: Message) {
        return message.traceId + '-' + message.taskId
    }
    /** 发送消息到服务器 */
    async sendToServer<T = unknown>(options: MessageOptions): Promise<T> {
        options.senderId = this.pivotId;
        const message: Message = new Message(options);
        // 如果还没有连接则尝试连接
        if (!this.connected) {
            await this.connect();
        }
        if (options.payload?.sync) {
            const autoReceiverId = this.createAutoReceiverIdByMessage(message);
            // 同步模式，消息发送到服务器后等待目标支点处理完成并响应结果
            const timeout = options?.payload?.syncTimeout || this.requestTimeout;
            message.payload.syncTimeout = timeout;
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingRequests.delete(autoReceiverId);
                    reject(new Error(`请求超时 (${timeout}ms): autoReceiverId=${autoReceiverId}`));
                }, timeout);

                this.pendingRequests.set(autoReceiverId, {
                    resolve: resolve as (v: unknown) => void,
                    reject,
                    timer,
                });

                debug(this.name, 'sync发送消息', message);
                this.onSend(message)?.catch((err) => {
                    clearTimeout(timer);
                    this.pendingRequests.delete(autoReceiverId);
                    reject(err);
                });
            });
        }

        // 异步模式，消息发送到服务器后服务器立即响应已接收到消息
        debug(this.name, '异步发送消息', message);
        return await this.onSend(message) as T;
    }

    // ─── 工具方法 ───

    /**
     * 处理收到的消息（子类在收到消息时调用此方法）
     * 默认行为：匹配 pending 请求并 resolve/reject，其余消息忽略
     * 子类可 override 并调用 super.handleIncoming(message)
     */
    protected async handleIncoming(message: Message): Promise<void> {
        // 1. 检查是否是待响应请求的回复
        const autoReceiverId = this.createAutoReceiverIdByMessage(message);
        const pending = this.pendingRequests.get(autoReceiverId);
        debug(this.name, pending ? '收到sync响应' : '收到异步响应', message);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(autoReceiverId);

            // 便捷确认消息是否异常
            if (message.error) {
                pending.reject(message);
            } else {
                pending.resolve(message);
            }
            return;
        }

        // 用于支持自动响应数据
        const reMsg = await this.onMessage(message);
        if (typeof reMsg == 'object') {
            // 如果是 Message 对象，那么就自动覆盖目标并发送 Message 对象
            // 如果你需要发给别人，应该手动显式发送
            reMsg.receiverId = message.senderId;
            reMsg.traceId = message.traceId;
            reMsg.taskId = message.taskId;
            this.sendToServer(reMsg);
        }
        return;
    }

    protected _rejectAllPending(reason: string): void {
        for (const [, req] of this.pendingRequests) {
            clearTimeout(req.timer);
            req.reject(new Error(reason));
        }
        this.pendingRequests.clear();
    }

    /** 获取当前待响应请求数量 */
    get pendingCount(): number {
        return this.pendingRequests.size;
    }

    /** 取消指定的待响应请求 */
    cancel(traceId: string, reason = "请求已取消"): boolean {
        const pending = this.pendingRequests.get(traceId);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(traceId);
            pending.reject(new Error(reason));
            return true;
        }
        return false;
    }

    /** 取消所有待响应请求 */
    cancelAll(reason = "所有请求已取消"): void {
        this._rejectAllPending(reason);
    }
}

// #endregion SDK基类
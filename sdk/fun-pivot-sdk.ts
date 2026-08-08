/**
 * Fun（函数调用）协议 SDK
 *
 * 本地函数调用模式，适合：
 * - 同一进程内的支点通信
 * - 测试环境
 * - 无需网络连接的本地开发
 *
 * 特点：
 * - 零网络开销
 * - 直接函数引用，无需序列化
 */
import type { FunAdapterType } from '../src/adapters/fun-adapter.ts';
import { S9yPivot, PivotError, type S9yPivotOptions } from './s9y-pivot-sdk.ts';
import { debug, type Message } from './type.ts';
export * from './type.ts';

// ─── 类型定义 ───

/** Fun SDK 配置选项 */
export interface FunPivotOptions extends S9yPivotOptions {
    /** 函数适配器，会在外部给当前 pivot 赋值 */
    funAdapter?: FunAdapterType;
    /** 收到对方主动推送的消息，子类按需 override */
    onMessage: (message: Message) => Promise<Message | void>
}

// ─── Fun SDK ───

/**
 * Fun SDK
 *
 * 基于本地函数调用的 SDK 实现
 * 用户传入一个 handler 函数，发消息时直接调用它
 */
export class FunPivot extends S9yPivot {
    funAdapter?: FunAdapterType;
    /** 给网关使用。适配当前的网关调用方式，使用箭头函数是为了保留作用域，这样send函数单独在其他地方也能使用 */
    send: (message: Message) => Promise<any>;

    constructor(options: FunPivotOptions) {
        super(options);
        this.onMessage = options.onMessage;
        this.send = (message) => super.handleIncoming(message);
    }

    protected async onSend(message: Message): Promise<unknown> {
        if (typeof this.funAdapter?.handle != 'function') throw new PivotError('无法发送消息! 因为未初始化 funAdapter 属性', 500);
        return this.funAdapter?.handle(message);
    };

    // ─── 子类实现 ───
    protected async onConnected() {
        debug(`FunSDK: 支点 ${this.pivotId} 已就绪（本地模式）`);
    }

    protected async onDisconnected() {
        debug(`FunSDK: 支点 ${this.pivotId} 已断开（本地模式）`);
    }
}
// 可以在此处更改，用于是否开启调试模式
export const debug = process.env.DEBUG ? (...args: any[]) => console.log(...args) : () => { };
// export const debug = (...args: any[]) => console.log(...args);  // 直接开启调试

/** sdk错误 */
export class PivotError extends Error {
    public code: number;

    constructor(message: string | undefined, code: number) {
        super(message);
        this.code = code;
        this.name = 'PivotError';
    }
}

/** 
 * 创建随机 traceId 
 * 如果需要伪uuid可以这样使用 `createTraceId(32,'0123456789abcdef').match(/.{1,4}/g).join('-')`
 */
export function createTraceId(length: number = 10, characters: string = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', prefix = 'n.') {
    const result = [];
    for (let i = 0; i < length - prefix.length; i++) {
        result.push(characters.charAt(Math.floor(Math.random() * characters.length)))
    }
    return prefix + result.join('')
}

/**
 * 消息类型
 * - push: 任务推送（网关 → 支点，或支点 → 网关）
 * - pipe: 管道协议（进度/结果/状态查询）
 * - register: 支点注册
 * - heartbeat: 心跳保活
 * - pivots: 查询支点列表 */
export type MessageType = "push" | "pipe" | "register" | "heartbeat" | "pivots" | string;

/** 
 * 消息载荷，用于做配置
 */
export class MessagePayload {
    /** 消息类型 */
    type: MessageType;
    /** 时间戳 (ms) */
    timestamp: number;
    /** 匹配目标支点名称 (模糊匹配，优先级次于 receiverId) */
    receiverName?: string;
    /** 匹配目标支点能力标签 (匹配优先级最低) */
    capabilities?: string[];
    /** 本次任务消耗的价格 (支持动态定价场景) */
    cost?: string;
    /** 价格表标识 (支持动态定价，仅做标记用) */
    priceTable?: string;
    /** 同步模式: 网关等待目标支点响应后直接返回 */
    sync?: boolean;
    /** 同步模式: 超时时间 */
    syncTimeout?: number;
    /** 允许任意其他属性 */
    [key: string]: unknown;

    constructor(payload: Partial<MessagePayload>) {
        if (typeof payload != "object") payload = {};
        for (const key in payload) {
            const val = payload[key];
            this[key] = val;
        }
        this.type = payload.type ?? "push";
        this.timestamp = payload.timestamp ?? Date.now();
        if (this.sync) {
            if (!(typeof this.syncTimeout != 'number' || 0 < this.syncTimeout)) this.syncTimeout = 300_000;
        }
    }
}

export type MessageOptions = Partial<Message>;
/** 消息类 */
export class Message {
    /** 发送方支点 ID */
    senderId: string;
    /** 目标支点 ID */
    receiverId?: string;
    /** 全链路追踪 ID 一个事件应当使用统一的一个id  
     * 例如: 需求user->gateway 然后 gateway 无论调用多少支点, 全程应当都带有统一的 traceId  */
    traceId: string;
    /** 任务 ID 仅用于本次发送消息与响应使用  
     * 例如: 发送a->b 且 回应b->a 总共2条一起组成单次任务 */
    taskId: string;
    /** 消息载荷 */
    payload: MessagePayload;
    /** 消息内容 */
    body: any;
    /** 失败信息, 用于任务处理失败时, 推荐写错误对象Error */
    error?: any;

    constructor(message: MessageOptions) {
        this.senderId = message.senderId ?? '-';
        if (message.receiverId != undefined) this.receiverId = message.receiverId;
        if (message.error != undefined) this.error = message.error;
        this.traceId = message.traceId ?? createTraceId();
        this.taskId = message.taskId ?? createTraceId(undefined, undefined, 'a.');
        this.payload = new MessagePayload(message.payload ?? {});
        if (message.body != undefined) this.body = message.body;
    }
}

/**
 * 支点类型
 * - user: 用户支点
 * - agent: AI 代理支点
 * - system: 系统支点
 * - gateway: 网关支点
 * - tool: 工具支点
 * - other: 其他类型
 */
export type PivotType = "user" | "agent" | "system" | "gateway" | "tool" | "other" | string;

/** 支点类构造参数 */
export type PivotOptions = {
    /** 支点唯一标识 */
    pivotId: string;
    /** 支点类型 */
    type: PivotType;
    /** 支点名称（可用于路由匹配） */
    name?: string;
    /** 支点能力标签（注册时声明，可用于路由匹配和筛选） */
    capabilities?: string[];
    /** 价格表标识（支持动态定价，仅做标记用） */
    priceTable?: string;
};

/** 支点类 */
export class Pivot {
    /** 支点唯一标识 */
    pivotId: string;
    /** 支点类型 */
    type: PivotType;
    /** 支点名称（可用于路由匹配） */
    name: string;
    /** 支点能力标签（注册时声明，可用于路由匹配和筛选） */
    capabilities?: string[];
    /** 价格表标识（支持动态定价，仅做标记用） */
    priceTable?: string;

    /**
     * 如果 capabilities 字段存在，且不是数组，则会将其转成字符串数组
     * @param pivot 
     */
    constructor(pivot: PivotOptions) {
        if (pivot.pivotId == undefined) throw new Error(`支点的 pivotId 字段不能为空!`);
        if (pivot.type == undefined) throw new Error(`支点的 type 字段不能为空!`);

        this.pivotId = pivot.pivotId;
        this.type = pivot.type;
        this.name = pivot.name ?? pivot.pivotId;
        if (pivot.capabilities != undefined) {
            this.capabilities = Array.isArray(pivot.capabilities) ? pivot.capabilities : [String(pivot.capabilities)];
        }
        if (pivot.priceTable != undefined) this.priceTable = pivot.priceTable;
    }
}
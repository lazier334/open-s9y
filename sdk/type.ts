/**
 * 消息类型
 * - push: 任务推送（网关 → 支点，或支点 → 网关）
 * - pipe: 管道协议（进度/结果/状态查询）
 * - register: 支点注册
 * - heartbeat: 心跳保活
 * - pivots: 查询支点列表
 */
export type MessageType = "push" | "pipe" | "register" | "heartbeat" | "pivots" | string;

/**
 * 支点类型
 * - user: 用户支点
 * - agent: AI 代理支点
 * - system: 系统支点
 * - gateway: 网关支点
 * - tool: 工具支点
 * - other: 其他类型
 */
export type PivotType = "user" | "agent" | "system" | "gateway" | "tool" | "other";

/**
 * 消息载荷
 * 根据消息类型不同，载荷结构有所差异
 */
export interface MessagePayload {
    /** 任务 ID，用于关联请求和响应 */
    taskId?: string;
    /** 业务数据 */
    data?: unknown;
    /** 所需能力标签（用于路由匹配） */
    capabilities?: string[];
    /** 错误信息（响应消息中携带） */
    error?: string;
    /** 任务状态（pending / in_progress / completed / failed） */
    status?: string;
    /** 本次消息消耗的价格（支持动态定价场景） */
    cost?: string;
    /** 支点 ID（register 消息时使用） */
    pivotId?: string;
    /** 支点名称（register 消息时使用） */
    name?: string;
    /** 支点类型（register 消息时使用） */
    type?: PivotType;
    /** pipe 协议类型（progress / result / status / 自定义） */
    protocol?: string;
    /** 价格表标识（支持动态定价，仅做标记用） */
    priceTable?: string;
    /** 同步模式：网关等待目标支点响应后直接返回 */
    sync?: boolean;
    /** 查询时仅查看不消费缓存 */
    peek?: boolean;
    /** 允许任意其他属性 */
    [key: string]: unknown;
}

/**
 * 消息结构
 * 网关内所有通信的统一格式
 */
export interface Message {
    /** 发送方支点 ID */
    senderId: string;
    /** 目标支点 ID（精确匹配，优先级最高） */
    targetId?: string;
    /** 目标支点名称（模糊匹配，优先级次于 targetId） */
    targetName?: string;
    /** 消息类型 */
    type: MessageType;
    /** 消息载荷 */
    payload: MessagePayload;
    /** 全链路追踪 ID（用于关联请求和响应） */
    traceId: string;
    /** 时间戳（ms） */
    timestamp: number;
}

/**
 * 支点信息
 * 支点注册时声明的基本信息
 */
export interface PivotInfo {
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
}

/**
 * 支点连接状态
 */
export interface Status {
    /** 连接建立时间（ms） */
    connectedAt: number;
    /** 最后一次心跳时间（ms） */
    lastHeartbeatAt: number;
    /** 负载值（预留，用于负载均衡） */
    load?: number;
}

/**
 * /pipe 接口的 Query 参数类型
 * - GET 和 POST 共用
 * - targetPivotId 仅在 GET 时有效，用于显式指定目标支点、跳过路由
 */
export interface PipeQuery {
    /** 任务 ID */
    taskId: string;
    /** 管道协议类型（progress / result / status / 自定义） */
    protocol?: string;
    /** 目标支点 ID（可选，跳过路由直接指定） */
    targetPivotId?: string;
}

/**
 * 网关对外暴露的 API，供插件和适配器调用
 */
export interface GatewayAPI {
    /** 向指定支点推送消息（异步，不等待响应） */
    routeTo(pivotId: string, message: Message): Promise<void>;
    /** 向指定支点请求流式进度（预留接口） */
    openStream(pivotId: string, message: Message): ReadableStream;
    /** 向指定支点请求并等待响应 */
    requestTo(pivotId: string, message: Message): Promise<unknown>;
}

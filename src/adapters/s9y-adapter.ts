import type { FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import type { GatewayServer } from "../server.ts";
import type { Message, PivotInfo } from "../../sdk/type.ts";
import type { Connection, AdapterType } from "../connection.ts";

/** 适配器错误 */
export class AdapterError extends Error {
    public code: number;

    constructor(message: string | undefined, code: number) {
        super(message);
        this.code = code;
        this.name = 'AdapterError';
    }
}

/**
 * 创建连接的参数
 */
export type ConnectionParams = Partial<PivotInfo> & Record<string, unknown> & {
    pivotId: string;
    capabilities: string[] | string | undefined;
    send: (message: Message) => Promise<unknown>,
    adapterType: AdapterType,
    options?: { enableHeartbeat?: boolean }
}

/**
 * 创建消息的参数
 */
export type MessageParams = Partial<Message> & Record<string, unknown> & {
    pivotId: string;
}

/**
 * S9y 适配器基类，继承者必须实现2个能力
 * - 注册支点监听(数据出口): const conn = await this.registerConnection(cp);
 * - 统一消息处理(数据入口): const result = await this.handleMessage(message);
 * 可选择自定义实现
 * - 身份认证: await this.authenticateRequest(request)
 */
export abstract class S9yAdapter {
    protected server: GatewayServer;

    constructor(server: GatewayServer) {
        this.server = server;
    }

    /** 身份认证, 可以传递任意参数, 实际类型是 unknown */
    protected async authenticateRequest(request: IncomingMessage | FastifyRequest) {
        return await this.server.connections.authenticateRequest(request)
    }

    /** 把消息交给服务器做处理 */
    protected async handleMessage(message: Message) {
        return await this.server.handleBizMessage(message)
    }

    /** 注册支点连接 */
    protected async registerConnection(cp: ConnectionParams): Promise<Connection> {
        if (typeof cp.pivotId != 'string') throw new AdapterError('pivotId 字段不存在!', 404);
        const result = this.server.connections.tryRegister(cp.pivotId);
        if (!result.accepted) {
            throw new AdapterError(result.reason, 409);
        }
        const pivotInfo = this.createPivotInfo(cp);
        const conn = await this.server.connections.addConnection(cp.pivotId, pivotInfo, cp.send, cp.adapterType, cp.options);
        return conn
    }

    /** 获取缓存的支点信息 (断连但未过期的连接) */
    protected getConnectionCached(pivotId: string): { pivotInfo: PivotInfo } | undefined {
        if (typeof pivotId == 'string') {
            const conn = this.server.connections.get(pivotId);
            if (conn && conn.disconnectAt !== undefined) {
                return { pivotInfo: conn.pivotInfo };
            }
        }
        return undefined;
    }

    /** 构建 PivotInfo 优先使用传入值, 回退到缓存值 */
    createPivotInfo(cp: ConnectionParams): PivotInfo {
        const cached = this.getConnectionCached(cp.pivotId);
        const capabilities: string[] | undefined = typeof cp.capabilities == 'string' ? cp.capabilities.split(",").map((s: string) => s.trim()).filter(Boolean) : undefined;
        const pivotInfo = {
            pivotId: cp.pivotId,
            type: cp.type ?? "other",
            name: cp.name,
            capabilities,
            priceTable: cp.priceTable
        };

        return { ...cached?.pivotInfo, ...pivotInfo } as PivotInfo;
    }

    /** 构建 Message 使用传入值, pivotId需要先注册存在缓存 */
    createMessage(cp: MessageParams): Message {
        const cached = this.getConnectionCached(cp.pivotId);
        if (!cached) throw new AdapterError('当前连接未注册, 无法创建消息!', 405);
        const message: Message = {
            senderId: cached.pivotInfo.pivotId,
            targetId: cp.targetId,
            targetName: cp.targetName,
            type: cp.type || 'push',
            payload: cp.payload || {},
            traceId: crypto.randomUUID(),
            timestamp: Date.now(),
        }
        if (!message?.senderId || !message?.type) {
            throw new AdapterError("消息格式无效", 400)
        }
        return message;
    }
}
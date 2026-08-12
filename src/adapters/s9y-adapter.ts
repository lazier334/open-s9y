import type { FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import type { GatewayServer } from "../server.ts";
import type { MessageOptions, PivotOptions } from "../../sdk/type.ts";
import type { Connection, AdapterType, ConnectionManager } from "../connection.ts";
import { Message, MessagePayload, Pivot } from "../../sdk/type.ts";

export * from "../../sdk/s9y-pivot-sdk.ts";

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
export type ConnectionOptions = PivotOptions & {
    send: (message: Message) => Promise<unknown>,
    adapterType: AdapterType,
}

/**
 * 创建消息的参数
 */
export type MessageParams = MessageOptions & {
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
    server: GatewayServer;
    connections: ConnectionManager;

    constructor(server: GatewayServer) {
        this.server = server;
        this.connections = server.connections;
    }

    /** 身份认证, 可以传递任意参数, 实际类型是 unknown */
    protected async authenticateRequest(request: IncomingMessage | FastifyRequest) {
        try {
            return await this.connections.authenticateRequest(request);
        } catch (err) {
            console.log('异常', err)
        }
    }

    /** 把消息交给服务器做处理 */
    protected async handleMessage(message: Message) {
        return await this.connections.handleBizMessageHook(message)
    }

    /** 注册支点连接 */
    protected async registerConnection(connOpts: ConnectionOptions): Promise<Connection> {
        if (typeof connOpts.pivotId != 'string') throw new AdapterError('pivotId 字段不存在或不是 string 类型!', 404);
        if (typeof connOpts.send != 'function') throw new AdapterError('send 字段不存在或不是 function 类型!', 404);
        const result = this.connections.tryRegister(connOpts.pivotId);
        if (!result.accepted) {
            throw new AdapterError(result.reason, 409);
        }
        const pivotInfo = this.createPivotInfo(connOpts);
        const conn = await this.connections.addConnection(connOpts.pivotId, pivotInfo, connOpts.send, connOpts.adapterType);
        return conn
    }

    /** 获取缓存的支点信息 (断连但未过期的连接) */
    protected getConnectionCached(pivotId: string): { pivotInfo: Pivot } | undefined {
        if (typeof pivotId == 'string') {
            const conn = this.connections.get(pivotId);
            if (conn && conn.disconnectAt !== undefined) {
                return { pivotInfo: conn.pivotInfo };
            }
        }
        return undefined;
    }

    /** 构建 PivotInfo 优先使用传入值, 回退到缓存值 */
    createPivotInfo(opts: PivotOptions): Pivot {
        const cached = this.getConnectionCached(opts.pivotId);
        const capabilities = opts.capabilities as string | string[] | undefined;
        if (typeof capabilities == 'string') opts.capabilities = capabilities.split(",").map((s: string) => s.trim()).filter(Boolean);
        const pivotInfo = new Pivot(opts as PivotOptions);
        return { ...cached?.pivotInfo, ...pivotInfo } as Pivot;
    }

    /** 构建 Message 使用传入值, pivotId需要先注册存在缓存 */
    createMessage(mp: MessageParams): Message {
        const cached = this.connections.get(mp.pivotId) || this.getConnectionCached(mp.pivotId);
        // 环境变量控制：是否允许未注册的客户端发送消息
        const allowUnregistered = process.env.ALLOW_UNREGISTERED_SEND === 'true';
        if (!cached && !allowUnregistered) {
            throw new AdapterError('当前连接未注册, 禁止创建消息!', 405);
        }
        const message: Message = new Message({
            // 需要保留原始的信息
            ...mp,
            senderId: cached?.pivotInfo.pivotId ?? mp.pivotId ?? mp.senderId,
            receiverId: mp.receiverId,
            payload: new MessagePayload(mp.payload || {}),
        });
        if (!message.senderId || !message.payload.type) {
            throw new AdapterError(`消息格式无效，缺少有效的 senderId: ${message?.senderId} 或 type: ${message?.payload?.type}`, 400)
        }
        return message;
    }
}
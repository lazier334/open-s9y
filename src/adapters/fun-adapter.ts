import type { Message } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";
import type { ConnectionParams } from "./s9y-adapter.ts";
import type { BasePivot } from "../../sdk/base-pivot-sdk.ts";
import { S9yAdapter, AdapterError } from "./s9y-adapter.ts";

export interface PivotFactory {
    (server: GatewayServer): BasePivot;
}

/**
 * 本地函数插件适配器  
 */
export class FunAdapter extends S9yAdapter {
    constructor(server: GatewayServer) {
        super(server);
    }

    /** 验证支点，一般无需使用 */
    async authenticate(cp: ConnectionParams): Promise<void> {
        // 验证插件，验证当前参数是否存在指定的字段
        const attr = {
            send: 'function',
            name: 'string',
            pivotId: 'string',
        };
        Object.entries(attr).forEach(([k, v]) => {
            if (typeof cp[k] != v) throw new AdapterError(`${k} 属性必须是一个 ${v} 类型!`, 555);
        });
    }

    /**
     * 注册支点，注册完成后没有响应内容
     * @param cp 
     * @returns 
     */
    async register(cp: ConnectionParams): Promise<void> {
        cp.adapterType = 'fun';
        cp.type = 'system';
        this.authenticate(cp);
        const conn = await this.registerConnection(cp);
    }

    /**
     * 消息处理，消息处理后需要返回内容
     * @param message 
     * @returns 
     */
    async handle(message: Message) {
        const result = await this.handleMessage(message);
        return result
    }
}
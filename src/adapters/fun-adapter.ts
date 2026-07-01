import type { Message } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";
import type { Connection } from "../connection.ts";
import type { ConnectionParams } from "./s9y-adapter.ts";
import type { BasePivot } from "../../sdk/base-pivot-sdk.ts";
import { S9yAdapter, AdapterError } from "./s9y-adapter.ts";
import usePlugins from "../../plugins/index.ts";

export type SendParam = ConnectionParams & ((message: Message) => Promise<any>);

export interface PivotFactory {
    (server: GatewayServer): BasePivot;
}

/**
 * 本地函数插件适配器  
 */
export class FunAdapter extends S9yAdapter {
    constructor(server: GatewayServer) {
        super(server);
        usePlugins(this);
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
    async register(send: SendParam): Promise<Connection> {
        let cp = send as ConnectionParams;
        if (typeof send == 'function') {
            cp = { send: send, name: send.name, pivotId: send.name } as unknown as ConnectionParams;
        }

        cp.adapterType = 'fun';
        cp.type = 'system';
        this.authenticate(cp);
        return await this.registerConnection(cp);
    }
    
    /**
     * 卸载支点，主要用于热更新的时候
     * @param pivotId 
     */
    unregister(pivotId: string) {
        return this.server.connections.removeConnection(pivotId)
    }

    /**
     * 消息处理，消息处理后需要返回内容
     * @param message 
     * @returns 
     */
    async handle(message: Message) {
        return await this.handleMessage(message);
    }
}

export type FunAdapterType = FunAdapter;
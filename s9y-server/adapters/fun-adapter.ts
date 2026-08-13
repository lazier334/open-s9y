import type { Message } from "@open-s9y/sdk";
import type { GatewayServer } from "../server.ts";
import type { Connection } from "../lib/connection.ts";
import type { FunPivot } from "../lib/fun-pivot-sdk.ts";
import { S9yAdapter } from "./s9y-adapter.ts";

/**
 * 本地函数插件适配器  
 */
export class FunAdapter extends S9yAdapter {
    constructor(server: GatewayServer) {
        super(server);
        // 将fun适配器注册到网关中
        server.init(this);
    }

    /**
     * 注册支点，注册完成后没有响应内容
     * @param cp 
     * @returns 
     */
    async register(pivot: FunPivot): Promise<Connection> {
        return await this.registerConnection({
            ...pivot,
            adapterType: 'fun',
            type: 'system',
        });
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
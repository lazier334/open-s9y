import type { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { GatewayServer } from "../server.ts";
import type { ConnectionOptions, AdapterError } from "./s9y-adapter.ts";
import { Message } from "@open-s9y/sdk";
import { S9yAdapter } from "./s9y-adapter.ts";

/**
 * WebSocket 协议适配器
 * - 处理支点 WS 连接握手、心跳、register
 * - 消息分发到 handleBizMessage
 * - 响应回传、错误处理
 */
export class WsAdapter extends S9yAdapter {
    constructor(server: GatewayServer) {
        super(server);

        this.server.wss.on("connection", async (socket: WebSocket, request: IncomingMessage) => {
            try {
                if (!await this.authenticateRequest(request)) {
                    throw new Error('身份验证失败');
                }
            } catch {
                return socket.close(1008, JSON.stringify({ code: 1008, msg: '身份验证失败' }));
            }
            // 此时直接注册
            const cp = this._parseQuery(request.url || '');
            // 注册连接
            cp.send = async (message: Message) => socket.send(JSON.stringify(message));
            cp.adapterType = 'ws';
            const conn = await this.registerConnection(cp);

            socket.on("message", async (raw: Buffer) => {
                try {
                    const data = JSON.parse(raw.toString());
                    const message = new Message(data);

                    // 心跳消息
                    if (message.payload.type === "heartbeat") {
                        if (conn?.pivotId) this.server.connections.updateHeartbeat(conn?.pivotId);
                        return;
                    }

                    // 强制异步处理消息，响应消息会走send通道，这里无需响应内容
                    message.payload.sync = false;
                    this.handleMessage(message);
                } catch (err) {
                    console.log('消息接收失败:', err);
                    const error = err as AdapterError;
                    const result = { code: error?.code || 503, msg: String(error?.message ?? error) };
                    return socket.send(JSON.stringify(result));
                }
            });

            socket.on("close", () => {
                if (conn?.pivotId) {
                    this.server.connections.removeConnection(conn?.pivotId);
                }
            });

            socket.on("error", () => {
                if (conn?.pivotId) {
                    this.server.connections.removeConnection(conn?.pivotId);
                }
            });
        });
    }

    /**
     * 解析 URL 中的 query string
     * - _json 字段视为 encodeURIComponent 编码的 JSON 对象，作为基础
     * - 其余字段逐项 decodeURIComponent 后尝试 JSON.parse，失败则保留原始字符串
     * - 返回 { ..._json, ...flat }（flat 覆盖 _json）
     */
    _parseQuery(url: string): ConnectionOptions {
        const si = url.indexOf("?");
        if (si === -1) return {} as ConnectionOptions;
        const params = new URLSearchParams(url.slice(si));
        const flat: Record<string, unknown> = {};
        params.forEach((v, k) => {
            try { flat[k] = JSON.parse(v); } catch { flat[k] = v; }
        });
        const jsonObj = typeof flat._json === "object" && flat._json !== null
            ? flat._json as Record<string, unknown>
            : {};
        return { ...jsonObj, ...flat } as ConnectionOptions;
    }
}

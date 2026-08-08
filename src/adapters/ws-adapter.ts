import type { WebSocket } from "ws";
import type { Message } from "../../sdk/type.ts";
import type { IncomingMessage } from "node:http";
import type { GatewayServer } from "../server.ts";
import type { ConnectionParams } from "./s9y-adapter.ts";
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
                socket.close(1008, '身份验证失败');
                return;
            }

            let pivotId: string | undefined;

            socket.on("message", async (raw: Buffer) => {
                let message = {} as Message;
                let cp: ConnectionParams | undefined;
                try {
                    const data = JSON.parse(raw.toString());

                    // 检查是否是标准 Message 格式（有 senderId 字段）
                    if (data.senderId && data.traceId) {
                        // 标准 Message 格式
                        message = data as Message;

                        // 如果是注册消息，构建 ConnectionParams
                        if (message.type === "register") {
                            cp = {
                                pivotId: message.senderId,
                                type: message.payload?.type as any || "other",
                                name: message.payload?.name as string,
                                capabilities: message.payload?.capabilities as string[],
                                priceTable: message.payload?.priceTable as string,
                            } as ConnectionParams;
                        }
                    } else {
                        // ConnectionParams 格式（旧格式）
                        cp = data as ConnectionParams;
                        message = this.createMessage(cp);
                    }

                    console.log("[WsAdapter DEBUG] 收到消息:", JSON.stringify(message).substring(0, 200));

                    // 心跳消息
                    if (message.type === "heartbeat") {
                        if (pivotId) this.server.connections.updateHeartbeat(pivotId);
                        return;
                    }

                    // 支点注册（WebSocket）
                    if (message.type === "register") {
                        // WS 的 send 函数：通过 WebSocket 发送消息
                        const send = async (msg: Message): Promise<unknown> => {
                            if (socket.readyState !== 1) {
                                throw new Error("WebSocket 未连接");
                            }
                            socket.send(JSON.stringify(msg));
                            return undefined;
                        };
                        // 注册连接
                        cp!.send = send;
                        cp!.adapterType = 'ws';
                        if (typeof cp!.options != 'object') cp!.options = {};
                        try {
                            const conn = await this.registerConnection(cp!);
                        } catch (err) {
                            // @ts-ignore
                            socket.close(1008, String(err?.message || err))
                        }
                        return;
                    }

                    // 统一业务消息处理
                    const result = await this.handleMessage(message);
                    // TODO 推送消息完成后需要把结果弄成 Message 来响应
                    if (result !== undefined && message.senderId) {
                        const response: Message = {
                            senderId: "gateway",
                            receiverId: message.senderId,
                            type: message.type,
                            payload: { data: result },
                            traceId: message.traceId,
                            timestamp: Date.now(),
                        };
                        await this.server.connections.requestTo(message.senderId, response);
                    }
                } catch (err) {
                    if (message.senderId) {
                        try {
                            const errorResponse: Message = {
                                senderId: "gateway",
                                receiverId: message.senderId,
                                type: message.type,
                                payload: { error: err instanceof Error ? err.message : String(err) },
                                traceId: message.traceId,
                                timestamp: Date.now(),
                            };
                            await this.server.connections.requestTo(message.senderId, errorResponse);
                        } catch {
                            console.error("消息处理异常:", err);
                        }
                    }
                }
            });

            socket.on("close", () => {
                if (pivotId) {
                    this.server.connections.removeConnection(pivotId);
                }
            });

            socket.on("error", () => {
                if (pivotId) {
                    this.server.connections.removeConnection(pivotId);
                }
            });
        });
    }
}

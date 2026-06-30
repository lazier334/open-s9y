import type { Message, PivotInfo } from "../../sdk/type.ts";
import type { WebSocket } from "ws";
import type { GatewayServer } from "../server.ts";
import type { IncomingMessage } from "node:http";
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
      if (!await this.server.connections.authenticateRequest(request)) {
        socket.close(1008, '身份验证失败');
        return;
      }

      let pivotId: string | undefined;

      socket.on("message", async (raw: Buffer) => {
        let message = {} as Message;
        try {
          message = JSON.parse(raw.toString()) as Message;

          // 心跳消息
          if (message.type === "heartbeat") {
            if (pivotId) {
              this.server.connections.updateHeartbeat(pivotId);
            }
            return;
          }

          // 注册消息
          if (message.type === "register") {
            const info = message.payload as unknown as PivotInfo & { pivotId?: string };
            pivotId = info.pivotId ?? message.senderId;

            const result = this.tryRegister(pivotId);
            if (!result.accepted) {
              socket.close(1008, result.reason);
              return;
            }

            const cached = this.getCached(pivotId);
            const pivotInfo = this.buildPivotInfo(pivotId, info, cached);

            // WS 的 send 函数：通过 WebSocket 发送消息
            const send = async (msg: Message): Promise<unknown> => {
              if (socket.readyState !== 1) {
                throw new Error("WebSocket 未连接");
              }
              socket.send(JSON.stringify(msg));
              return undefined;
            };

            await this.server.connections.addConnection(pivotId, pivotInfo, send, "ws", {
              enableHeartbeat: true,
            });
            return;
          }

          // 响应消息处理（通过 traceId 关联）
          if (this.handlePendingRequest(message)) {
            return;
          }

          // 统一业务消息处理
          const result = await this.server.handleBizMessage(message);
          if (result !== undefined && message.senderId) {
            const response: Message = {
              senderId: "gateway",
              targetId: message.senderId,
              type: message.type,
              payload: { data: result },
              traceId: message.traceId,
              timestamp: Date.now(),
            };
            await this.server.routeTo(message.senderId, response);
          }
        } catch (err) {
          if (message.senderId) {
            try {
              const errorResponse: Message = {
                senderId: "gateway",
                targetId: message.senderId,
                type: message.type,
                payload: { error: err instanceof Error ? err.message : String(err) },
                traceId: message.traceId,
                timestamp: Date.now(),
              };
              await this.server.routeTo(message.senderId, errorResponse);
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

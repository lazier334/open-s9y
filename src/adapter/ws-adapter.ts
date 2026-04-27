import type { WebSocketServer, WebSocket } from "ws";
import type { Message, PivotInfo } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";

/**
 * WebSocket 协议适配器
 * - 处理支点 WS 连接握手、心跳、register
 * - 消息分发到 server.handleBizMessage()
 * - 响应回传、错误处理
 */
export class WsAdapter {
  private server: GatewayServer;
  constructor(server: GatewayServer) { this.server = server; }

  setup(wss: WebSocketServer): void {
    wss.on("connection", (socket: WebSocket) => {
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

            const result = this.server.connections.tryRegister(pivotId);
            if (!result.accepted) {
              socket.close(1008, result.reason);
              return;
            }

            const cached = this.server.connections.getCache(pivotId);
            const pivotInfo: PivotInfo = {
              pivotId,
              type: info.type ?? cached?.pivotInfo.type ?? "other",
              capabilities: info.capabilities ?? cached?.pivotInfo.capabilities,
              priceTable: info.priceTable ?? cached?.pivotInfo.priceTable,
            };

            this.server.connections.addWs(pivotId, pivotInfo, socket);
            return;
          }

          // 响应消息处理（通过 traceId 关联）
          const pendingReq = this.server.pendingRequests.get(message.traceId);
          if (pendingReq) {
            clearTimeout(pendingReq.timer);
            this.server.pendingRequests.delete(message.traceId);
            if (message.payload?.error) {
              pendingReq.reject(new Error(String(message.payload.error)));
            } else {
              pendingReq.resolve(message.payload?.data ?? message.payload);
            }
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
          this.server.connections.removeWs(pivotId);
        }
      });

      socket.on("error", () => {
        if (pivotId) {
          this.server.connections.removeWs(pivotId);
        }
      });
    });
  }
}

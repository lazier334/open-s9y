import type { Message, PivotInfo } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";

/**
 * S9y 适配器基类
 * - 提取 http/ws/fun 适配器的公共逻辑
 * - 统一 PivotInfo 构建、注册验证等操作
 */
export abstract class S9yAdapter {
    protected server: GatewayServer;

    constructor(server: GatewayServer) {
        this.server = server;
    }

    /**
     * 构建 PivotInfo，优先使用传入值，回退到缓存值
     */
    protected buildPivotInfo(
        pivotId: string,
        raw: Partial<PivotInfo> & Record<string, unknown>,
        cached?: { pivotInfo: PivotInfo }
    ): PivotInfo {
        const rawCaps = raw.capabilities as string[] | string;
        const capabilities: string[] | undefined = Array.isArray(rawCaps)
            ? rawCaps.map(String)
            : typeof rawCaps === "string"
                ? rawCaps.split(",").map((s: string) => s.trim()).filter(Boolean)
                : cached?.pivotInfo.capabilities;

        return {
            pivotId,
            type: (raw.type as PivotInfo["type"]) ?? cached?.pivotInfo.type ?? "other",
            name: (raw.name as string) ?? cached?.pivotInfo.name,
            capabilities,
            priceTable: (raw.priceTable as string) ?? cached?.pivotInfo.priceTable,
        };
    }

    /**
     * 尝试注册支点，返回是否成功
     */
    protected tryRegister(pivotId: string): { accepted: boolean; reason?: string } {
        return this.server.connections.tryRegister(pivotId);
    }

    /**
     * 获取缓存的支点信息（断连但未过期的连接）
     */
    protected getCached(pivotId: string): { pivotInfo: PivotInfo } | undefined {
        const conn = this.server.connections.get(pivotId);
        if (conn && conn.disconnectAt !== undefined) {
            return { pivotInfo: conn.pivotInfo };
        }
        return undefined;
    }

    /**
     * 处理待响应的请求（通过 traceId 关联）
     */
    protected handlePendingRequest(message: Message): boolean {
        const pendingReq = this.server.pendingRequests.get(message.traceId);
        if (pendingReq) {
            clearTimeout(pendingReq.timer);
            this.server.pendingRequests.delete(message.traceId);
            if (message.payload?.error) {
                pendingReq.reject(new Error(String(message.payload.error)));
            } else {
                pendingReq.resolve(message.payload?.data ?? message.payload);
            }
            return true;
        }
        return false;
    }

    /**
     * 统一业务消息处理
     */
    async handleBizMessage(message: Message): Promise<unknown> {
        return this.server.handleBizMessage(message);
    }
}

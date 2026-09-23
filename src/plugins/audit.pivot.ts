/**
 * 身份验证Pivot  
 * 用于校验接入请求的有效性, fun模式不会进行验证
 */
import type { FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import { type Connection, FunPivot } from "@open-s9y/gateway";
import { Message, MessagePayload } from "@open-s9y/sdk";

const pluginPivotId = process.env.AUDIT_PIVOT_ID ?? "audit";
const KEY_NAME = process.env.AUDIT_KEY_NAME ?? "s9y-key";
const AUTH_KEYS = (process.env.AUDIT_AUTH_KEYS ?? "user,agent,system,gateway,tool,other")
    .split(",").map((s) => s.trim()).filter(Boolean);

/**
 * 获取cookie信息
 */
function getCookie(headers: Record<string, string | string[] | undefined>, name: string) {
    const raw = headers["cookie"];
    if (!raw) return undefined;
    const str = Array.isArray(raw) ? raw.join("; ") : raw;
    const match = str.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1];
}

/**
 * 验证 session 并返回身份信息
 * 返回 null 表示认证失败
 */
async function authenticate(session: string): Promise<{ subject: string } & Record<string, unknown> | null> {
    if (!session) return null;
    if (AUTH_KEYS.includes(session)) return { subject: session };
    return null;
}

/**
 * 检查此身份是否有权限注册该 pivot
 * 返回 true 表示授权通过
 */
async function authorize(
    identity: { subject: string } & Record<string, unknown>,
    connection: Connection
): Promise<boolean> {
    // TODO 生产环境请使用真正的验证
    return connection.pivotInfo.type == identity.subject;
}

export const pivot = new FunPivot({
    pivotId: pluginPivotId,
    capabilities: ["audit"],
    type: "system",
    /**
     * 任务分发决策
     * - 从 message.payload.capabilities 提取所需能力
     * - 通过 gateway.connections 获取实时在线支点
     * - 选择 assignedCount 最小的支点
     */
    async onMessage(message) {
        const { connection, request } = (message.body ?? {}) as {
            connection?: Connection;
            request?: FastifyRequest | IncomingMessage;
        };

        if (!request) throw new Error("Audit: 缺少 request");
        const search = new URLSearchParams(request.url?.substring(request.url.indexOf('?')) ?? '');
        const session = search.get(KEY_NAME) || getCookie(request.headers, KEY_NAME) || '';

        if (message.payload.type == 'authenticateRequest') {
            const auth = await authenticate(session);
            return new Message({ body: auth });
        } else {
            if (!connection) throw new Error("Audit: 缺少 connection");

            // 注册授权
            const identity = session ? await authenticate(session) : null;
            if (!identity) {
                throw new Error(`Audit拒绝 ${connection.pivotInfo.pivotId}: 无法验证身份`);
            }

            const authorized = await authorize(identity, connection);
            if (!authorized) {
                throw new Error(`Audit拒绝 ${connection.pivotInfo.pivotId}: 无权限注册此支点`);
            }

            console.info(`Audit通过: ${connection.pivotInfo.pivotId} identity=${JSON.stringify(identity)}`);
            return new Message({
                payload: new MessagePayload({
                    authorized: true
                })
            });
        }
    }
});

export default pivot;
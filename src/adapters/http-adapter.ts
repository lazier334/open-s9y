import type { Message } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";
import { S9yAdapter } from "./s9y-adapter.ts";

/**
 * HTTP 协议适配器
 * - 注册 Fastify HTTP 路由
 * - GET  /s9y — 支点注册（长轮询）
 * - POST /s9y — 消息推送（混合 query + body）
 *
 * 混合参数合并规则：
 *   1. query 中的 _json 字段（encodeURIComponent 后的 JSON）作为基础对象
 *   2. query 其余字段逐项尝试 JSON.parse，覆盖 _json
 *   3. body（仅 POST）覆盖 query
 *   合并后删除 _json 残留 key。
 */

// ─── query 解析 ───

/**
 * 解析 URL 中的 query string
 * - _json 字段视为 encodeURIComponent 编码的 JSON 对象，作为基础
 * - 其余字段逐项 decodeURIComponent 后尝试 JSON.parse，失败则保留原始字符串
 * - 返回 { ..._json, ...flat }（flat 覆盖 _json）
 */
function parseQuery(url: string): Record<string, unknown> {
    const si = url.indexOf("?");
    if (si === -1) return {};
    const params = new URLSearchParams(url.slice(si));
    const flat: Record<string, unknown> = {};
    params.forEach((v, k) => {
        try { flat[k] = JSON.parse(v); } catch { flat[k] = v; }
    });
    const jsonObj = typeof flat._json === "object" && flat._json !== null
        ? flat._json as Record<string, unknown>
        : {};
    return { ...jsonObj, ...flat };
}

// ─── HttpAdapter ───

export class HttpAdapter extends S9yAdapter {
    constructor(server: GatewayServer) {
        super(server);
        const { fastify } = server;

        // ── GET /s9y ── 支点注册（长轮询）
        fastify.get("/s9y", async (request, reply) => {
            const q = parseQuery(request.url);
            const pivotId = (q.pivotId as string) ?? "unknown";

            try {
                const result = this.tryRegister(pivotId);
                if (!result.accepted) {
                    return reply.code(409).send({ error: result.reason });
                }

                const cached = this.getCached(pivotId);
                const pivotInfo = this.buildPivotInfo(pivotId, q, cached);

                // HTTP 长轮询的 send 函数：发送消息并等待客户端响应
                let sendResolve: (value: unknown) => void;
                let sendReject: (reason?: unknown) => void;
                const sendPromise = new Promise<unknown>((resolve, reject) => {
                    sendResolve = resolve;
                    sendReject = reject;
                });

                const send = async (msg: Message): Promise<unknown> => {
                    if (!reply.sent) {
                        reply.code(200).send(msg);
                        sendResolve(msg);
                        return msg;
                    }
                    throw new Error("HTTP 连接已响应");
                };

                const conn = await this.server.connections.addConnection(pivotId, pivotInfo, send, "http");

                // 长轮询超时或断开时清理
                const cleanConn = () => {
                    clearTimeout(timer);
                    if (this.server.connections.get(pivotId) === conn) {
                        this.server.connections.removeConnection(pivotId);
                    }
                    sendResolve(null);
                };

                // 超时返回 noop
                const timer = setTimeout(() => {
                    send({ type: "noop" } as Message).catch(() => { });
                    cleanConn();
                }, this.server.requestTimeout);

                reply.raw.on("close", cleanConn);

                return sendPromise;
            } catch (err) {
                return reply.code(503).send({ error: err instanceof Error ? err.message : String(err) });
            }
        });

        // ── POST /s9y ── 消息推送（混合 query + body）
        fastify.post("/s9y", async (request, reply) => {
            const queryObj = parseQuery(request.url);
            const body = (request.body as Record<string, unknown>) ?? {};
            const merged = { ...queryObj, ...body };
            delete merged._json;
            const message = merged as unknown as Message;

            if (!message?.senderId || !message?.type) {
                return reply.code(400).send({ error: "消息格式无效" });
            }

            // 处理响应匹配
            if (this.handlePendingRequest(message)) {
                return reply.code(200).send({ status: "ok" });
            }

            if (!this.server.pluginPivotId) {
                return reply.code(503).send({ error: "未配置插件 pivot" });
            }

            try {
                const result = await this.server.handleBizMessage(message);
                return reply.code(202).send(result);
            } catch (err) {
                return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
            }
        });
    }
}

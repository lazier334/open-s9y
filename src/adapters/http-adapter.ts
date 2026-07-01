import type { Message } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";
import type { ConnectionParams } from "./s9y-adapter.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import { S9yAdapter, AdapterError } from "./s9y-adapter.ts";

/**
 * HTTP 协议适配器
 * - 注册 Fastify HTTP 路由
 * - GET  /s9y — 支点注册（长轮询）
 * - POST /s9y — 消息推送（混合 query + body）
 *
 */
export class HttpAdapter extends S9yAdapter {

    constructor(server: GatewayServer) {
        super(server);
        const { fastify } = server;

        // 身份验证，默认全部请求都需要验证
        const authenticateRequestOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
            if (!await this.authenticateRequest(request)) {
                return reply.code(401).send({ error: '身份验证失败' });
            }
        };
        let authenticateRequest = authenticateRequestOrigin;
        // 开启管理接口，此时 /index.html 无需验证，可以从这里返回秘钥
        if (process.env.API_ADMIN == 'true') {
            authenticateRequest = async (request: FastifyRequest, reply: FastifyReply) => {
                const path = (request.url ?? "").split('?').shift() ?? "";
                // 首页页面跳过认证
                if (path === '/') return reply.redirect('/index.html');
                if (path === "/index.html") return;
                // 进行验证
                return await authenticateRequestOrigin(request, reply);
            }
        }
        fastify.addHook('preHandler', authenticateRequest);

        // ── GET /s9y ── 支点注册（Http长轮询）
        fastify.get("/s9y", async (request, reply) => {
            const cp = this._parseQuery(request.url);
            try {
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

                // 注册连接
                cp.send = send;
                cp.adapterType = 'http';
                const conn = await this.registerConnection(cp);

                // 长轮询超时或断开时清理
                const cleanConn = () => {
                    clearTimeout(timer);
                    if (this.server.connections.get(cp.pivotId) === conn) {
                        this.server.connections.removeConnection(cp.pivotId);
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
                if (err instanceof AdapterError) return reply.code(err?.code || 503).send({ error: err?.message });
                return reply.code(503).send({ error: String(err) });
            }
        });

        // ── POST /s9y ── 消息推送（混合 query + body）
        fastify.post("/s9y", async (request, reply) => {
            const q = this._parseQuery(request.url);
            const body = (request.body as Record<string, unknown>) ?? {};
            const merged = { ...q, ...body };
            delete merged._json;
            try {
                const message = this.createMessage(merged);
                const result = await this.handleMessage(message);
                // TODO 推送消息完成后需要把结果弄成 Message 来响应
                return reply.code(202).send(result);
            } catch (err) {
                if (err instanceof AdapterError) return reply.code(err?.code || 503).send({ error: err?.message });
                return reply.code(503).send({ error: String(err) });
            }
        });
    }


    /**
     * 解析 URL 中的 query string
     * - _json 字段视为 encodeURIComponent 编码的 JSON 对象，作为基础
     * - 其余字段逐项 decodeURIComponent 后尝试 JSON.parse，失败则保留原始字符串
     * - 返回 { ..._json, ...flat }（flat 覆盖 _json）
     */
    _parseQuery(url: string): ConnectionParams {
        const si = url.indexOf("?");
        if (si === -1) return {} as ConnectionParams;
        const params = new URLSearchParams(url.slice(si));
        const flat: Record<string, unknown> = {};
        params.forEach((v, k) => {
            try { flat[k] = JSON.parse(v); } catch { flat[k] = v; }
        });
        const jsonObj = typeof flat._json === "object" && flat._json !== null
            ? flat._json as Record<string, unknown>
            : {};
        return { ...jsonObj, ...flat } as ConnectionParams;
    }
}

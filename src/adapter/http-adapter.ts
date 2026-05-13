import type { Message, PivotInfo } from "../../sdk/type.ts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { GatewayServer } from "../server.ts";

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

export class HttpAdapter {
  private server: GatewayServer;
  constructor(server: GatewayServer) { this.server = server; }

  register(fastify: FastifyInstance): void {

    // ── GET /s9y ── 支点注册（长轮询）
    fastify.get("/s9y", async (request, reply) => {
      const q = parseQuery(request.url);
      const pivotId = (q.pivotId as string) ?? "unknown";
      const send = (msg: any, code: number = 200) => {
        if (!reply.sent) reply.code(code).send(msg);
        else throw new Error("当前请求已响应");
      };

      try {
        const result = this.server.connections.tryRegister(pivotId);
        if (!result.accepted) {
          return send({ error: result.reason }, 409);
        }

        const cached = this.server.connections.getCache(pivotId);
        const rawCaps = q.capabilities;
        const capabilities: string[] | undefined = Array.isArray(rawCaps)
          ? rawCaps.map(String)
          : typeof rawCaps === "string"
            ? rawCaps.split(",").map((s: string) => s.trim()).filter(Boolean)
            : cached?.pivotInfo.capabilities;

        const pivotInfo: PivotInfo = {
          pivotId,
          type: (q.type as PivotInfo["type"]) ?? cached?.pivotInfo.type ?? "other",
          name: (q.name as string) ?? cached?.pivotInfo.name,
          capabilities,
          priceTable: (q.priceTable as string) ?? cached?.pivotInfo.priceTable,
        };
        const conn = await this.server.connections.addHttp(pivotId, pivotInfo, reply, request);
        conn.send = send;

        return new Promise<void>((resolve, reject) => {
          let timer: any;
          const cleanConn = () => {
            try {
              clearTimeout(timer);
              conn.send = () => { throw new Error("HTTP 连接已断开"); };
              if (this.server.connections.get(pivotId) === conn) {
                this.server.connections.removeHttp(pivotId);
              }
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          timer = setTimeout(() => {
            send({ type: "noop" }, 200);
            cleanConn();
          }, this.server.requestTimeout);

          conn.send = (msg: Message) => {
            send(msg, 200);
            cleanConn();
          };
          reply.raw.on("close", cleanConn);
        });
      } catch (err) {
        return send({ error: err instanceof Error ? err.message : String(err) }, 503);
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

      const pendingReq = this.server.pendingRequests.get(message.traceId);
      if (pendingReq) {
        clearTimeout(pendingReq.timer);
        this.server.pendingRequests.delete(message.traceId);
        if (message.payload?.error) {
          pendingReq.reject(new Error(String(message.payload.error)));
        } else {
          pendingReq.resolve(message.payload?.data ?? message.payload);
        }
        return reply.code(200).send({ status: "ok" });
      }

      if (!this.server.pluginPivotId) {
        return reply.code(503).send({ error: "未配置插件 pivot" });
      }

      try {
        const result = await this.server.handleBizMessage(message);
        return reply.code(202).send(result);
      } catch (err) {
        return reply
          .code(500)
          .send({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}

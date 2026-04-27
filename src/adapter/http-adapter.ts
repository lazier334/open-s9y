import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Message, PivotInfo, PipeQuery, PivotsQuery } from "../../sdk/type.ts";
import type { GatewayServer } from "../server.ts";
import { randomUUID } from "node:crypto";

/**
 * HTTP 协议适配器
 * - 注册 Fastify HTTP 路由
 * - HTTP 长轮询注册、任务提交、管道中继
 */
export class HttpAdapter {
  private server: GatewayServer;
  constructor(server: GatewayServer) { this.server = server; }

  register(fastify: FastifyInstance): void {
    // ── POST /register ──
    fastify.post<{ Body: Partial<PivotInfo> & { pivotId?: string } }>(
      "/register",
      async (request, reply) => {
        const body = request.body;
        const pivotId = body.pivotId ?? "unknown";
        const send = (msg: any, code: number = 200) => {
          if (!reply.sent) reply.code(code).send(msg);
          else throw new Error("当前请求已响应");
        };

        const result = this.server.connections.tryRegister(pivotId);
        if (!result.accepted) {
          return send({ error: result.reason }, 409);
        }

        const cached = this.server.connections.getCache(pivotId);
        const pivotInfo: PivotInfo = {
          pivotId,
          type: body.type ?? cached?.pivotInfo.type ?? "other",
          name: body.name ?? cached?.pivotInfo.name,
          capabilities: body.capabilities ?? cached?.pivotInfo.capabilities,
          priceTable: body.priceTable ?? cached?.pivotInfo.priceTable,
        };

        const conn = this.server.connections.addHttp(pivotId, pivotInfo, reply);
        conn.send = send;

        return new Promise<void>((resolve, reject) => {
          let timer: any;
          const cleanConn = () => {
            try {
              clearTimeout(timer);
              conn.send = () => {
                throw new Error("HTTP 连接已断开");
              };
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
      }
    );

    // ── POST /push ──
    fastify.post<{ Body: Message }>("/push", async (request, reply) => {
      const message = request.body;
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

    // ── GET /pipe ──
    fastify.get<{ Querystring: PipeQuery }>(
      "/pipe",
      async (request, reply) => {
        const protocol = request.query.protocol ?? "result";
        const taskId = request.query.taskId;
        let targetPivotId = request.query.targetPivotId;

        if (!targetPivotId) {
          targetPivotId = this.server.connections.getPivotId(taskId);
        }

        if (!targetPivotId) {
          return reply.code(404).send({ error: "目标支点未找到" });
        }
        if (!this.server.connections.has(targetPivotId)) {
          return reply.code(503).send({ error: "支点离线" });
        }

        this._setPipeWaiter(protocol, taskId, reply);

        const msg: Message = {
          senderId: "gateway",
          targetId: targetPivotId,
          type: "pipe",
          payload: { taskId, protocol },
          traceId: randomUUID(),
          timestamp: Date.now(),
        };

        try {
          await this.server.routeTo(targetPivotId, msg);
          reply.hijack();
        } catch (err) {
          const key = this._pipeWaiterKey(protocol, taskId);
          const waiter = this.server.pipeWaiters.get(key);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.server.pipeWaiters.delete(key);
            if (!reply.sent) {
              reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
            }
          }
        }
      }
    );

    // ── POST /pipe ──
    fastify.post<{ Querystring: PipeQuery }>(
      "/pipe",
      {
        config: { rawBody: true },
        bodyLimit: 1024 ** 3,
        preParsing: async (request, _reply, payload) => {
          request.headers["content-type"] = "application/octet-stream";
          return payload;
        },
      },
      async (request, reply) => {
        const protocol = request.query.protocol ?? "result";
        const taskId = request.query.taskId;

        if (!taskId) {
          return reply.code(400).send({ error: "Missing taskId" });
        }

        const resolved = await this._resolvePipeWaiter(
          protocol,
          taskId,
          request
        );
        if (!resolved) {
          return reply.code(409).send({ error: "消费方不存在" });
        }

        return { status: "delivered" };
      }
    );

    // ── GET /pivots ──
    fastify.get<{ Querystring: PivotsQuery }>("/pivots", async (request, reply) => {
      const capsFilter = request.query.capabilities
        ? request.query.capabilities.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const result = await this.server.handleBizMessage({
        senderId: "gateway",
        type: "pivots",
        payload: { capabilities: capsFilter },
        traceId: randomUUID(),
        timestamp: Date.now(),
      });
      return reply.code(200).send(result);
    });

    // ── GET /shutdown ──（仅 ALLOW_SHUTDOWN 环境变量为真时注册）
    if (process.env.ALLOW_SHUTDOWN == 'true') {
      fastify.get("/shutdown", async (_request, reply) => {
        reply.code(202).send({ status: "正在关机中" });
        console.log('系统正在关机中...');
        this.server.close().catch(() => process.exit(0));
      });
    }
  }

  // ─── 管道中继辅助 ───

  private _pipeWaiterKey(protocol: string, taskId: string): string {
    return `${taskId}:${protocol}`;
  }

  private _setPipeWaiter(
    protocol: string,
    taskId: string,
    reply: FastifyReply
  ): void {
    const key = this._pipeWaiterKey(protocol, taskId);
    const timer = setTimeout(() => {
      this.server.pipeWaiters.delete(key);
      if (!reply.sent) {
        reply.code(504).send({ error: "超时" });
      }
    }, this.server.requestTimeout);

    reply.raw.on("close", () => {
      clearTimeout(timer);
      this.server.pipeWaiters.delete(key);
    });

    this.server.pipeWaiters.set(key, { reply, timer });
  }

  private async _resolvePipeWaiter(
    protocol: string,
    taskId: string,
    request: FastifyRequest
  ): Promise<boolean> {
    const key = this._pipeWaiterKey(protocol, taskId);
    const waiter = this.server.pipeWaiters.get(key);

    if (!waiter) {
      console.log("无等待者:", key);
      return false;
    }

    const targetRaw = waiter.reply.raw;
    const sourceRaw = request.raw;

    if (targetRaw.writableEnded || targetRaw.destroyed) {
      console.log("目标连接已关闭");
      this.server.pipeWaiters.delete(key);
      return false;
    }

    const statusCode =
      parseInt(request.headers["x-pipe-status"] as string) || 200;
    let headers: Record<string, string> = {};
    try {
      const headerStr = request.headers["x-pipe-headers"] as string;
      if (headerStr) {
        headers = JSON.parse(headerStr);
      }
    } catch (e) {
      console.warn("解析 headers 失败:", e);
    }

    waiter.reply.hijack();
    targetRaw.writeHead(statusCode, {
      ...headers,
      "Transfer-Encoding": "chunked",
      "X-Pipe-Protocol": protocol,
      "X-Accel-Buffering": "no",
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (success: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(waiter.timer);
        this.server.pipeWaiters.delete(key);
        success ? resolve(true) : reject(new Error("Stream failed"));
      };

      sourceRaw.pipe(targetRaw);

      sourceRaw.on("end", () => {
        targetRaw.end();
        cleanup(true);
      });

      sourceRaw.on("error", (err) => {
        console.error("源流错误:", err.message);
        targetRaw.destroy();
        cleanup(false);
      });

      targetRaw.on("error", (err) => {
        console.error("目标流错误:", err.message);
        sourceRaw.destroy();
        cleanup(false);
      });

      targetRaw.on("close", () => {
        console.log("目标关闭（客户端断开）");
        sourceRaw.destroy();
        cleanup(false);
      });

      waiter.timer = setTimeout(() => {
        console.error("管道传输超时");
        sourceRaw.destroy();
        targetRaw.destroy();
        cleanup(false);
      }, this.server.requestTimeout * 10);
    });
  }
}

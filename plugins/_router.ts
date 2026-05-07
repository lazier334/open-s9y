import type { GatewayServer } from "../src/server.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPivot(server: GatewayServer): void {
    let fastify = server.fastify;
    // ── 第1层：网络级 cookie 认证 ──
    fastify.addHook('preHandler', async (request, reply) => {
        const path = (request.raw.url ?? "").split('?').shift() ?? "";
        // 管理页面及其 API 跳过认证
        if (path === "/index.html" || path.startsWith("/admin/")) return;
        // 进行验证
        if (!await server.connections.authenticateRequest(request)) {
            return reply.code(401).send({ error: '身份验证失败' });
        }
    });

    // ── GET /shutdown ──（仅 API_SHUTDOWN 环境变量为真时注册）
    if (process.env.API_SHUTDOWN == 'true') {
        fastify.get("/shutdown", async (_request, reply) => {
            reply.code(202).send({ status: "正在关机中" });
            console.log('系统正在关机中...');
            server.close().catch(() => process.exit(0));
        });
    }

    // ── 管理面板（仅 API_ADMIN 环境变量为真时注册）──
    if (process.env.API_ADMIN == 'true') {
        function readIndexFile() {
            const htmlPath = join(__dirname, "index.html");
            try {
                return readFileSync(htmlPath, "utf-8");
            } catch (err) {
                console.warn("[Admin] 无法读取 index.html，管理面板不可用");
                return String(err);
            }
        }
        let htmlCache = readIndexFile();

        fastify.get("/index.html", async (_request, reply) => {
            reply.header("Set-Cookie", `${process.env.AUDIT_KEY_NAME ?? "s9y-key"}=user; Path=/; SameSite=Lax`);
            // if (!htmlCache) return reply.code(503).send({ error: "管理页面未找到" });
            // return reply.type("text/html; charset=utf-8").send(htmlCache);
            return reply.type("text/html; charset=utf-8").send(readIndexFile());
        });

        fastify.get("/admin/api/status", async (_request, reply) => {
            const broker = server.connections.getLocal("broker-01");
            const tasks = broker && typeof (broker as any).getTasksSummary === "function"
                ? (broker as any).getTasksSummary() : [];
            const terminal = broker && typeof (broker as any).getTerminalTasksSummary === "function"
                ? (broker as any).getTerminalTasksSummary() : [];
            const cached = broker && typeof (broker as any).getCachedResultsSummary === "function"
                ? (broker as any).getCachedResultsSummary() : [];

            const all = server.getAllPivots();
            const pivots = all.map((p) => {
                const conn = server.connections.get(p.pivotId);
                return {
                    pivotId: p.pivotId,
                    type: p.type,
                    name: p.name,
                    capabilities: p.capabilities,
                    adapterType: conn?.socket ? "ws" : conn?.reply ? "http" : "fun",
                    status: conn?.status ?? null,
                };
            });
            return reply.code(200).send({ pivots, tasks, terminal, cached });
        });
    }
}

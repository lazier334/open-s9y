import type { FastifyRequest, FastifyReply } from "fastify";
import type { GatewayServer } from "../src/server.ts";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../config.json");

// ─── 主入口 ───

export function createPivot(server: GatewayServer): void {
    let fastify = server.fastify;
    // ── 第1层：网络级 cookie 认证 ──
    // 身份验证函数
    let authenticateRequest = async (request: FastifyRequest, reply: FastifyReply) => {
        if (!await server.connections.authenticateRequest(request)) {
            return reply.code(401).send({ error: '身份验证失败' });
        }
    };
    if (process.env.API_ADMIN == 'true') {
        const authenticateRequestOrigin = authenticateRequest;
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

    // ── GET /shutdown ──（仅 API_SHUTDOWN 环境变量为真时注册）
    if (process.env.API_SHUTDOWN == 'true') {
        fastify.get("/shutdown", async (_request, reply) => {
            reply.code(202).send({ status: "正在关机中" });
            console.log('系统正在关机中...');
            server.close().catch(() => process.exit(0));
        });
        fastify.post("/restart", async (_request, reply) => {
            reply.code(202).send({ status: "正在重启中" });
            console.log('系统正在重启...');
            const cmd = (process.env.GATEWAY_CMD ?? "npm run gateway").trim();
            const [bin, ...args] = cmd.split(/\s+/);
            const child = spawn(bin, args, {
                detached: true,
                stdio: "inherit",
                env: process.env,
                cwd: process.cwd(),
            });
            child.unref();
            server.close().catch(() => { });
            // 给新进程一点时间启动，然后退出旧进程
            setTimeout(() => process.exit(0), 500);
        });
    }

    // ── 管理面板（仅 API_ADMIN 环境变量为真时注册）──
    if (process.env.API_ADMIN == 'true') {
        let htmlCache = readIndexFile();
        function readIndexFile() {
            const htmlPath = join(__dirname, "index.html");
            try {
                return readFileSync(htmlPath, "utf-8");
            } catch (err) {
                console.warn("无法读取 index.html，管理面板不可用");
                return String(err);
            }
        }

        ['/', '/index.html'].forEach(p => fastify.get(p, async (_request, reply) => {
            reply.header("Set-Cookie", `${process.env.AUDIT_KEY_NAME ?? "s9y-key"}=user; Path=/; SameSite=Lax`);
            return reply.type("text/html; charset=utf-8").send(readIndexFile());
        }));

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

        // ── 配置读写 API ──
        fastify.get("/admin/api/config", async (_request, reply) => {
            try {
                const raw = readFileSync(CONFIG_PATH, "utf-8");
                const config = JSON.parse(raw);
                if (config.API_CONFIG) {
                    return reply.code(200).send(config);
                }
                // 不允许修改配置时，仅返回开关状态
                return reply.code(200).send({
                    API_CONFIG: config.API_CONFIG ?? false,
                    API_SHUTDOWN: config.API_SHUTDOWN ?? false,
                });
            } catch (err) {
                return reply.code(500).send({ error: "无法读取配置文件" });
            }
        });

        fastify.post("/admin/api/config", async (request, reply) => {
            try {
                if (!process.env.API_CONFIG) return reply.code(500).send({ error: "已禁止修改配置文件" });
                const body = request.body as Record<string, unknown>;
                if (!body || typeof body !== "object") {
                    return reply.code(400).send({ error: "无效的配置数据" });
                }
                // 基于原配置合并变更，防止空对象/部分字段覆盖导致配置丢失
                let existing: Record<string, unknown> = {};
                try {
                    const raw = readFileSync(CONFIG_PATH, "utf-8");
                    existing = JSON.parse(raw);
                    if (!existing.API_CONFIG) return reply.code(500).send({ error: "已禁止修改配置文件" });
                    // 清理多余的内容
                    Object.keys(body).forEach(k => !Object.hasOwn(existing, k) && delete body[k])
                } catch {
                    // 配置文件不存在时从零创建
                }
                const merged = { ...existing, ...body };
                const json = JSON.stringify(merged, null, 2);
                writeFileSync(CONFIG_PATH, json + "\n", "utf-8");
                // 实时更新 process.env（运行时生效，重启后 .env 中的值优先）
                for (const [key, value] of Object.entries(merged)) {
                    process.env[key] = String(value);
                }
                console.log(`配置已更新 (合并后共 ${Object.keys(merged).length} 项)`);
                return reply.code(200).send({ ok: true, total: Object.keys(merged).length });
            } catch (err) {
                return reply.code(500).send({ error: "无法保存配置文件" });
            }
        });
    }

}

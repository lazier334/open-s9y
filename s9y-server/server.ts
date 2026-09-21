import type { Server } from "node:https";
import type { Message } from "@open-s9y/sdk";
import type { FastifyInstance } from "fastify";
import type { S9yAdapter, FunAdapterType } from "./adapters/index.ts";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import forge from 'node-forge';
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { FunPivot, ConnectionManager, scanAndRegisterPlugins } from "./lib/index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 网关pivot */
export const gatewayPivot = new FunPivot({
    pivotId: 'gateway',
    type: 'system',
    capabilities: ['gateway'],
    async onMessage(message: Message) { },
});

export interface GatewayServerOptions {
    port?: number;
    /** 心跳检测间隔（ms），超时未收到心跳则断开连接 */
    heartbeatInterval?: number;
    /** 支点超时时间（ms），超时未收到心跳则视为离线 */
    pivotTimeout?: number;
    /** 请求响应超时时间（ms） */
    requestTimeout?: number;
    /** 支点断连后缓存保留时间（ms），用于重连时恢复状态 */
    pivotCacheTTL?: number;
    /** 路由插件的 pivotId，用于动态路由解析 */
    pluginPivotId?: string;
    /** fun支点目录 */
    funPivotDir: string;
}

/**
 * 网关服务器主类
 *
 * 职责：
 * - 管理 HTTP + WebSocket 双协议服务器生命周期
 * - 协议处理委托给适配器（HttpAdapter / WsAdapter / FunAdapter）
 * - 连接治理通过 ConnectionManager 统一管理
 */
export class GatewayServer {
    // #region 网关类
    port: number;
    fastify: FastifyInstance;
    wss: WebSocketServer;
    connections: ConnectionManager;
    pluginPivotId?: string;
    funPivotDir: string;

    /** 已完成的 taskId 集合，用于去重 */
    readonly completedTasks = new Set<string>();
    /** 请求响应超时时间（ms） */
    readonly requestTimeout: number;
    /** 服务器关闭时执行的回调函数列表 */
    closeHandlers: Array<() => void | Promise<void>> = [];

    constructor(options: GatewayServerOptions = { funPivotDir: path.join(__dirname, '../plugins') }) {

        /**
         * 使用 node-forge 生成自签名证书
         */
        function generateSelfSignedCertificate(): { key: string; cert: string } {
            // 1. 生成 RSA 密钥对（2048 位）
            const keys = forge.pki.rsa.generateKeyPair(2048);

            // 2. 创建证书对象
            const now = new Date();
            const cert = forge.pki.createCertificate();
            cert.publicKey = keys.publicKey;
            cert.serialNumber = '01' + now.getTime().toString(16);                      // 简单唯一序列号
            cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);    // 1 天前生效
            cert.validity.notAfter = now;
            cert.validity.notAfter.setFullYear(now.getFullYear() + 10);                 // 有效期 10 年

            // 3. 设置证书主体和颁发者信息（自签名，两者相同）
            const attrs = [
                { name: 'commonName', value: 'localhost' },
                { name: 'organizationName', value: 'Development' },
                { name: 'countryName', value: 'CN' },
            ];
            cert.setSubject(attrs);
            cert.setIssuer(attrs);

            // 4. 设置扩展属性（关键：subjectAltName 让浏览器接受 localhost）
            cert.setExtensions([
                {
                    name: 'subjectAltName',
                    altNames: [
                        { type: 2, value: 'localhost' },   // DNS
                        { type: 7, ip: '127.0.0.1' },      // IPv4
                        { type: 7, ip: '::1' },            // IPv6
                    ],
                },
                {
                    name: 'basicConstraints',
                    cA: false, // 不是 CA 证书
                },
                {
                    name: 'keyUsage',
                    digitalSignature: true,
                    keyEncipherment: true,
                },
                {
                    name: 'extKeyUsage',
                    serverAuth: true,
                },
            ]);
            // 5. 自签名（用私钥签名）
            cert.sign(keys.privateKey, forge.md.sha256.create());
            // 6. 转换为 PEM 格式
            const key = forge.pki.privateKeyToPem(keys.privateKey);
            const certPem = forge.pki.certificateToPem(cert);
            return { key, cert: certPem };
        }

        this.fastify = Fastify({
            logger: false,
            https: process.env.TLS_KEY && process.env.TLS_CERT ? {
                key: process.env.TLS_KEY,
                cert: process.env.TLS_CERT
            } : (() => {
                const keyFile = path.join(process.cwd(), 'server.key');
                const crtFile = path.join(process.cwd(), 'server.crt');
                if (!fs.existsSync(keyFile) || !fs.existsSync(crtFile)) {
                    // 生成证书
                    const { key, cert } = generateSelfSignedCertificate();
                    // 私钥权限 600
                    fs.writeFileSync(keyFile, key, { mode: 0o600 });
                    fs.writeFileSync(crtFile, cert, 'utf8');
                    console.info('已生成证书文件！位于', [keyFile, crtFile])
                }

                return {
                    key: fs.readFileSync(keyFile, 'utf8'),
                    cert: fs.readFileSync(crtFile, 'utf8')
                }
            })()
        });
        this.wss = new WebSocketServer({ server: this.fastify.server as Server });
        this.requestTimeout = options.requestTimeout ?? 30_000;
        this.pluginPivotId = options.pluginPivotId;
        this.port = options.port ?? 10000;
        this.funPivotDir = options.funPivotDir;

        // 注册 octet-stream 解析器，用于接收二进制流数据
        this.fastify.addContentTypeParser(
            "application/octet-stream",
            (_request, payload, done) => done(null, payload)
        );

        this.connections = new ConnectionManager({
            gatewayPivot,
            heartbeatInterval: options.heartbeatInterval,
            pivotTimeout: options.pivotTimeout,
            pivotCacheTTL: options.pivotCacheTTL,
            pluginPivotId: options.pluginPivotId,
        });
        // 重写消息处理函数
        this.connections.handleBizMessageHook = (...args) => this.handleBizMessageHook(...args);
    }

    // 初始化适配器（由适配器调用）
    async init(funAdapter: FunAdapterType) {
        // 给 Pivot 添加 Adapter 并注册
        this.connections.setFunAdapter(funAdapter)
        // 初始化系统其他插件
        scanAndRegisterPlugins(funAdapter, this.funPivotDir);
        // 启动服务器
        this.start();
    }

    /** 加载适配器 */
    async loadAdapter(AdapterClass: new (...args: any[]) => S9yAdapter): Promise<S9yAdapter> {
        let adapter = new AdapterClass(this);
        console.info('已注册 Adapter:', AdapterClass.name);
        return adapter;
    }

    /** 启动服务器 */
    async start() {
        // 启动服务器
        const address = await this.listen();
        console.log(`网关服务正在监听: ${address}`);

        const shutdown = () => this.close().then(() => process.exit(0));
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }

    /**
     * 启动服务器监听
     * @param port 监听端口，端口被占用时自动重试（最多 5 次）
     * @returns 监听地址
     */
    async listen(port?: number): Promise<string> {
        if (port == undefined) port = this.port;
        const maxRetries = 5;
        const isAddressUseError = (err: Error | unknown) => err instanceof Error && err?.message?.startsWith('listen EADDRINUSE: address already in use');

        this.wss.on('error', (err) => {
            if (!isAddressUseError(err)) throw err;
        });

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await this.fastify.listen({ port: port, host: "0.0.0.0" });
            } catch (err) {
                if (isAddressUseError(err)) {
                    if (attempt < maxRetries) {
                        console.warn(`端口 ${port} 被占用, 1秒后重试 (${attempt}/${maxRetries})...`);
                        await new Promise((r) => setTimeout(r, 1000));
                        continue;
                    }
                }
                throw err;
            }
        }
        throw new Error(`端口 ${port} 启动失败`);
    }

    /** 注册关闭回调，在服务器关闭时按注册顺序执行 */
    onClose(handler: () => void | Promise<void>): void {
        this.closeHandlers.push(handler);
    }

    /** 关闭服务器，依次清理回调、待处理请求、连接和协议服务器 */
    async close(): Promise<void> {
        for (const handler of this.closeHandlers) {
            await handler();
        }
        this.completedTasks.clear();

        // 清理连接管理器
        this.connections.close();
        // 关闭wss和http
        this.wss.close();
        await this.fastify.close();
    }

    // #endregion 网关类
    // #region 重写 handleBizMessageHook

    // ─── 业务消息处理 ───

    /**
     * 统一处理业务消息
     * - pivots 类型：查询支点列表
     * - 其他类型：路由到目标支点处理
     * @returns pivots 查询返回支点列表，其他返回路由结果
     */
    async handleBizMessageHook(message: Message): Promise<unknown> {
        // 查询全部支点的请求
        if (message.payload.type === "pivots") {
            return this._handlePivotsQuery(message);
        }

        // 调用 connection 的处理
        return this.connections.handleBizMessage(message);
    }

    /** 查询支点列表 */
    private async _handlePivotsQuery(message: Message): Promise<unknown> {
        const required = message.payload?.capabilities ?? [];
        const all = this.connections.getAll();

        const pivots = Array.from(all.entries())
            .filter(([_, conn]) =>
                required.length === 0 || required.every((c: string) => conn.pivotInfo.capabilities?.includes(c))
            ).map(([pid, conn]) => ({
                pivotId: pid,
                type: conn.pivotInfo.type,
                name: conn.pivotInfo.name,
                capabilities: conn.pivotInfo.capabilities,
                connectedAt: conn.connectedAt,
                lastHeartbeatAt: conn.lastHeartbeatAt,
            }));

        return { pivots };
    }

    // #endregion 重写 handleBizMessageHook
}

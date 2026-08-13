/**
 * WebSocket 协议 SDK
 *
 * 基于 WebSocket 长连接的支点通信实现
 * - 支持双向消息传递
 * - 自动心跳保活
 * - 断线自动重连（可选）
 */
import WebSocket from "ws";
import { Message, debug } from "./s9y-type.ts";
import { S9yPivot, type S9yPivotOptions } from "./s9y-pivot-sdk.ts";
export * from './s9y-type.ts';

// ─── 类型定义 ───

/** WebSocket SDK 配置选项 */
export interface WsPivotOptions extends S9yPivotOptions {
    /** 网关地址，如 ws://localhost:3000 或 wss://gateway.example.com */
    gatewayUrl: string;
    /** 请求头 */
    headers?: Record<string, string>;
    /** 心跳间隔（ms），默认 30000 */
    heartbeatInterval?: number;
}

// ─── WebSocket SDK ───

/**
 * WebSocket SDK
 *
 * 基于 WebSocket 的 SDK 实现
 */
export class WsPivot extends S9yPivot {
    private ws: WebSocket | null = null;
    private heartbeatTimer?: NodeJS.Timeout;
    private readonly gatewayUrl: string;
    private readonly headers: Record<string, string>;
    private readonly heartbeatInterval: number;
    private _waitConnection: boolean = false;

    constructor(options: WsPivotOptions) {
        super(options);
        this.heartbeatInterval = options.heartbeatInterval ?? 60_000;
        this.gatewayUrl = options.gatewayUrl;
        this.headers = options.headers || {};
    }

    protected async onSend(message: Message): Promise<unknown> {
        if (this.checkDisConnection()) {
            throw new Error("WsSDK: WebSocket 未连接");
        }
        return new Promise((resolve, reject) => {
            this.ws!.send(JSON.stringify(message), (err) => {
                if (err) reject(err);
                else resolve(undefined);
            });
        });
    }

    // ─── 子类实现 ───
    protected async onConnect() {
        // 连接并注册
        await this._register();
        debug(`WsSDK: 支点 ${this.pivotId} 已就绪（ws模式）`);
    }
    protected async onDisconnect() {
        this._stopHeartbeat();

        if (this.ws) {
            this.ws.close(1000, "客户端主动断开");
            this.ws = null;
        }
        debug(`WsSDK: 支点 ${this.pivotId} 已断开（ws模式）`);
    }

    // ─── 内部方法 ───
    private checkDisConnection() {
        return !this.ws || this.ws.readyState !== WebSocket.OPEN
    }

    /**
     * 连接ws并注册
     */
    private async _register(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this._waitConnection || !this.checkDisConnection()) {
                return console.log('WsSDK: 已连接或正在尝试连接');
            }
            this._waitConnection = true;
            const wsUrl = new URL(this.gatewayUrl);
            wsUrl.searchParams.set("pivotId", this.pivotId);
            wsUrl.searchParams.set("name", this.name);
            wsUrl.searchParams.set("type", this.type);
            if (this.capabilities?.length) wsUrl.searchParams.set("capabilities", this.capabilities.join(","));
            if (this.priceTable) wsUrl.searchParams.set("priceTable", this.priceTable);
            this.ws = new WebSocket(wsUrl.href, { headers: this.headers });

            this.ws.on("open", () => {
                this._startHeartbeat();
                console.log(`WsSDK: 已连接到 ${wsUrl.href}`);
                resolve();
                this._waitConnection = false;
            });

            this.ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
                try {
                    const text = Buffer.isBuffer(data)
                        ? data.toString()
                        : Array.isArray(data)
                            ? Buffer.concat(data).toString()
                            : new TextDecoder().decode(data);
                    const msg = JSON.parse(text) as Message;
                    this.handleIncoming(msg);
                } catch (e) {
                    console.error("WsSDK: 消息解析失败:", e);
                }
            });

            this.ws.on("close", (code, reason) => {
                this._stopHeartbeat();
                console.log(`WsSDK: 连接已断开: ${JSON.stringify({ code, reason })}`);
            });

            this.ws.on("error", (err) => {
                console.error("WsSDK: 连接错误:", err);
                reject(err);
                this._waitConnection = false;
            });
        });
    }

    private _startHeartbeat(): void {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                const hb = new Message({
                    senderId: this.pivotId,
                    payload: { type: "heartbeat", timestamp: Date.now(), },
                });
                this.ws.send(JSON.stringify(hb));
            }
        }, this.heartbeatInterval);
    }

    private _stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
}

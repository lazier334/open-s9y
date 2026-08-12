/**
 * WebSocket 协议 SDK
 *
 * 基于 WebSocket 长连接的支点通信实现
 * - 支持双向消息传递
 * - 自动心跳保活
 * - 断线自动重连（可选）
 */
import { S9yPivot, type S9yPivotOptions } from "./s9y-pivot-sdk.ts";
import { Message } from "./type.ts";
import WebSocket from "ws";
export * from './type.ts';


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
    private readonly url: string;
    private readonly headers: Record<string, string>;
    private readonly heartbeatInterval: number;

    constructor(options: WsPivotOptions) {
        super(options);
        this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
        this.url = options.gatewayUrl;
        this.headers = options.headers || {};
    }

    // ─── 子类实现 ───

    protected async doConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url, { headers: this.headers });

            this.ws.on("open", () => {
                this._startHeartbeat();
                console.log(`[WsSDK] 已连接到 ${this.url}`);
                resolve();
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
                    console.error("[WsSDK] 消息解析失败:", e);
                }
            });

            this.ws.on("close", (code, reason) => {
                this._stopHeartbeat();
                console.log(`[WsSDK] 连接已断开: code=${code}, reason=${reason}`);
            });

            this.ws.on("error", (err) => {
                console.error("[WsSDK] 连接错误:", err);
                reject(err);
            });
        });
    }

    protected doDisconnect(): void {
        this._stopHeartbeat();
        if (this.ws) {
            this.ws.close(1000, "客户端主动断开");
            this.ws = null;
        }
    }

    protected async onSend(message: Message): Promise<unknown> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("[WsSDK] WebSocket 未连接");
        }

        return new Promise((resolve, reject) => {
            this.ws!.send(JSON.stringify(message), (err) => {
                if (err) reject(err);
                else resolve(undefined);
            });
        });
    }

    protected async onConnect() {
        // 发送注册消息
        this._sendRegister();
    }

    // ─── 内部方法 ───

    private _sendRegister(): void {
        const registerMsg = {
            pivotId: this.pivotId,
            type: this.type,
            name: this.name,
            capabilities: this.capabilities,
            priceTable: this.priceTable,
        };
        this.ws?.send(JSON.stringify(registerMsg));
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

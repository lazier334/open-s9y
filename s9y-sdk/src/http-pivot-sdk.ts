/**
 * HTTP 协议 SDK
 *
 * 基于 HTTP 短连接/长轮询的支点通信实现
 * - 无状态通信
 * - 支持长轮询接收消息
 * - 适合无状态部署场景
 */
import { debug, Message } from './s9y-type.ts';
import { S9yPivot, type S9yPivotOptions } from './s9y-pivot-sdk.ts';

// ─── 类型定义 ───

/** HTTP SDK 配置选项 */
export interface HttpPivotOptions extends S9yPivotOptions {
    /** 网关地址，如 http://localhost:3000 或 https://gateway.example.com */
    gatewayUrl: string;
    /** 请求头 */
    headers?: Record<string, string>;
    /** 长轮询超时时间（ms），默认 60000 */
    longPollTimeout?: number;
    /** 是否启用长轮询接收消息，默认 true */
    enableLongPoll?: boolean;
}

// ─── HTTP SDK ───

/**
 * HTTP SDK
 *
 * 基于 HTTP 的 SDK 实现
 */
export class HttpPivot extends S9yPivot {
    private longPollAbort?: AbortController;
    private longPollRunning = false;

    private readonly baseUrl: string;
    private readonly headers: Record<string, string>;
    private readonly longPollTimeout: number;
    private readonly enableLongPoll: boolean;

    constructor(options: HttpPivotOptions) {
        super(options);
        this.longPollTimeout = options.longPollTimeout ?? 60_000;
        this.enableLongPoll = options.enableLongPoll ?? true;
        this.baseUrl = options.gatewayUrl;
        this.headers = options.headers || {};
    }

    protected async onSend(message: Message): Promise<unknown> {
        const res = await this._send({
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(message),
        });
        if (!res.ok) {
            let re = '';
            try {
                re = await res.text()
            } catch (err) {
                // console.error('读取结果失败');
            }
            throw new Error(`HttpSDK 发送失败: ${res.status} ${res.statusText} \n${re}`);
        }
        return await res.json();

    }


    // ─── 子类实现 ───
    protected async onConnect() {
        // 至少发送等待消息一次，用来注册当前支点，并且启动长轮询，这样可以避开多次调用等待导致的冲突
        this._startLongPoll();
        debug(`HttpSDK: 支点 ${this.pivotId} 已就绪（http模式）`);
    }

    protected async onDisconnect() {
        this._stopLongPoll();
        debug(`HttpSDK: 支点 ${this.pivotId} 已断开（http模式）`);
    }

    // ─── 内部方法 ───
    /**
     * 
     * @param message 消息
     * @param reqOpts fetch的配置
     * @returns 
     */
    private async _send(reqOpts: Record<string, any>): Promise<Response> {
        const params = new URLSearchParams();
        params.set("pivotId", this.pivotId);
        params.set("name", this.name);
        params.set("type", this.type);
        if (this.capabilities?.length) params.set("capabilities", this.capabilities.join(","));
        if (this.priceTable) params.set("priceTable", this.priceTable);
        const url = `${this.baseUrl}/s9y?${params.toString()}`;

        if (typeof reqOpts?.headers != 'object') reqOpts.headers = {};
        debug('HttpSDK: 发起请求:', url, reqOpts)
        // 监听，结果丢给消息处理
        // 发送任务，结果直接丢弃
        return fetch(url, {
            ...reqOpts,
            headers: {
                ...this.headers,
                ...reqOpts.headers,
            },
        });
    }

    /**
     * 等待网关推送消息
     * @returns 延迟等待时间
     */
    private async _waitMessage(): Promise<number | undefined> {
        try {
            const res = await this._send({
                method: "GET",
                signal: this.longPollAbort?.signal,
            });
            debug('HttpSDK: 收到消息推送');

            if (!res.ok) {
                if (res.status === 409) {
                    console.warn("HttpSDK: 轮询冲突, 2秒后重试...", await res.text());
                    return 2000;
                }
                const text = await res.text();
                console.error(`HttpSDK: 轮询失败: ${res.status}`, text);
                return 5000;
            }

            const text = await res.text();
            if (!text || text.trim() === "") {
                return;
            }

            const msg = JSON.parse(text) as Message;
            if (msg.payload?.type === "noop") {
                return;
            }

            this.handleIncoming(msg);
        } catch (err: unknown) {
            if (err instanceof Error && err.name === "AbortError") {
                return;
            }
            console.error("HttpSDK: 轮询异常:", err);
            return 5000;
        }
    }

    private _startLongPoll(): void {
        if (this.longPollRunning) return;
        this.longPollRunning = true;
        this.longPollAbort = new AbortController();

        const loop = async () => {
            do {
                await this._delay(await this._waitMessage() || 0);
            } while (this.longPollRunning);
        };

        loop().catch(() => { });
    }

    private _stopLongPoll(): void {
        this.longPollRunning = false;
        this.longPollAbort?.abort();
        this.longPollAbort = undefined;
    }

    private _delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

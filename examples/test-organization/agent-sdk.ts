/**
 * 通用 Agent SDK（纯客户端，无业务逻辑）
 * - 继承 BasePivot，连接网关
 * - 提供 callAI、_sendMessage、_getPeers 等底层能力
 * - onTask 抽象方法，由子类实现业务逻辑
 */

import { BasePivot } from "../../src/client/base-pivot.ts";
import type { Message as GWMessage } from "../../src/protocol/message.ts";

export interface AgentSDKOptions {
  /** 网关地址 */
  gatewayUrl: string;
  /** 支点唯一标识 */
  pivotId: string;
  /** 支点类型 */
  type: "agent" | "gateway" | "tool";
  /** 能力声明 */
  capabilities?: Record<string, unknown>;
  /** 是否使用 WebSocket */
  useWebSocket?: boolean;
  /** AI API 地址 */
  apiUrl?: string;
  /** AI API Key */
  apiKey: string;
  /** AI 模型 */
  model?: string;
  /** 日志回调 */
  onLog?: (...args: any[]) => void;
  /** 错误日志回调 */
  onError?: (...args: any[]) => void;
  /** AI temperature，默认 0（确定性输出） */
  temperature?: number;
}

export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatResult {
  content: string | null;
  tool_calls?: ToolCall[];
}

/**
 * 通用 Agent SDK
 * 纯客户端抽象，不绑定任何业务逻辑。
 */
export abstract class AgentSDK extends BasePivot {
  protected apiUrl: string;
  protected apiKey: string;
  protected model: string;
  protected temperature: number;
  protected onLog?: (...args: any[]) => void;
  protected onError?: (...args: any[]) => void;

  constructor(options: AgentSDKOptions) {
    super({
      gatewayUrl: options.gatewayUrl,
      pivotId: options.pivotId,
      type: options.type as any,
      capabilities: options.capabilities ?? {},
      useWebSocket: options.useWebSocket ?? false,
    });

    this.apiUrl = options.apiUrl ?? "https://api.deepseek.com/v1";
    this.apiKey = options.apiKey;
    this.model = options.model ?? "deepseek-chat";
    this.temperature = options.temperature ?? 0;
    this.onLog = options.onLog;
    this.onError = options.onError;
  }

  /** 统一日志（优先回调，无回调时走 console） */
  protected _log(...args: any[]): void {
    if (this.onLog) {
      this.onLog(...args);
    } else {
      console.log(...args);
    }
  }

  /** 统一错误日志（优先回调，无回调时走 console） */
  protected _err(...args: any[]): void {
    if (this.onError) {
      this.onError(...args);
    } else {
      console.error(...args);
    }
  }

  /** 建立连接并输出协议标记 */
  async connect(): Promise<void> {
    await super.connect();
    this._log(
      `[Protocol] ${this.options.pivotId} → REGISTER(${this.options.type})`
    );
  }

  /** 子类必须实现：收到网关推送的任务 */
  abstract onTask(message: GWMessage): Promise<void>;

  /** 网关查询结果时返回（默认空实现） */
  onResultRequest(_taskId: string): unknown {
    return { status: "completed" };
  }

  /** 网关查询进度时返回（默认空实现） */
  onProgressRequest(): undefined {
    return undefined;
  }

  /** 调用 AI API（非流式，支持 function call） */
  protected async callAI(
    messages: AIMessage[],
    tools?: any[]
  ): Promise<ChatResult> {
    const body: any = {
      model: this.model,
      messages,
      temperature: this.temperature,
      max_tokens: 800,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`AI API ${res.status}: ${text}`);
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? null,
      tool_calls: msg?.tool_calls,
    };
  }

  /** 获取当前在线的所有 agent（排除自己） */
  protected async _getPeers(): Promise<
    Array<{ pivotId: string; type: string; capabilities?: unknown }>
  > {
    this._log(
      `[Protocol] ${this.options.pivotId} → QUERY(gateway/peers)`
    );
    try {
      const res = await fetch(`${this.options.gatewayUrl}/pivots`);
      if (!res.ok) return [];
      const data = (await res.json()) as { pivots?: any[] };
      return (data.pivots || [])
        .filter((p) => p.pivotId !== this.options.pivotId)
        .map((p) => ({
          pivotId: p.pivotId,
          type: p.type,
          capabilities: p.capabilities,
        }));
    } catch {
      return [];
    }
  }

  /** 向指定支点发送消息 */
  protected async _sendMessage(
    targetId: string,
    data: unknown,
    extra?: Record<string, unknown>
  ): Promise<void> {
    this._log(
      `[Protocol] ${this.options.pivotId} → PIPE(${targetId})`
    );
    this._log(`[${this.options.pivotId}] 📤 → ${targetId}`);
    await this.push({
      senderId: this.options.pivotId,
      targetId,
      type: "push",
      payload: {
        taskId: `msg-${Date.now()}`,
        data,
        ...extra,
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }

  /** 向指定支点发送广播消息 */
  protected async _sendBroadcast(
    targetId: string,
    eventType: string,
    eventData: unknown
  ): Promise<void> {
    this._log(
      `[Protocol] ${this.options.pivotId} → BROADCAST(${eventType}, ${targetId})`
    );
    this._log(`[${this.options.pivotId}] 📢 → ${targetId} [${eventType}]`);
    await this.push({
      senderId: this.options.pivotId,
      targetId,
      type: "push",
      payload: {
        taskId: `broadcast-${Date.now()}`,
        data: { broadcast: true, eventType, eventData },
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }
}

/**
 * 简单的 AI Agent 客户端
 * - 继承 BasePivot，支持 HTTP/WS 双模式
 * - 调用 OpenAI 兼容 API，支持 function call（get_peers / send_message）
 * - 自治定时器：每秒检查，15 秒未发言自动触发 free_action
 * - stay_silent 时延迟 10 秒再次检查
 *
 * 使用方式：
 *   import { Agent } from "./examples/Agent.ts";
 *   const agent = new Agent({ gatewayUrl, pivotId, apiKey, systemPrompt: "..." });
 *   await agent.connect();
 */

import { BasePivot } from "../src/client/base-pivot.ts";
import type { Message as GWMessage } from "../src/protocol/message.ts";

export interface AgentOptions {
  /** 网关地址 */
  gatewayUrl: string;
  /** 支点唯一标识 */
  pivotId: string;
  /** 支点类型，默认 "agent" */
  type?: string;
  /** 能力声明，默认 { chat: true } */
  capabilities?: Record<string, unknown>;
  /** 是否使用 WebSocket，默认 false（HTTP 长轮询更稳定） */
  useWebSocket?: boolean;
  /** AI API 地址，默认 https://api.deepseek.com/v1 */
  apiUrl?: string;
  /** AI API Key */
  apiKey: string;
  /** AI 模型名称，默认 deepseek-chat */
  model?: string;
  /** 系统提示词，用于设定 AI 身份信息 */
  systemPrompt?: string;
}

interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface QueuedTask {
  message: GWMessage;
}

const FREE_ACTION_INTERVAL = 15000; // 15 秒

/**
 * 简单 Agent 类
 * - 消息排队处理，不跳过任何消息
 * - 自治定时器：每秒检查，15 秒未发言自动找人聊天
 * - stay_silent 时 10 秒后再次检查
 * - 通过 get_peers / send_message 工具实现多 agent 对话
 */
export class Agent extends BasePivot {
  private apiUrl: string;
  private apiKey: string;
  private model: string;
  private messages: AIMessage[] = [];

  /** 消息队列 */
  private queue: QueuedTask[] = [];
  /** 是否正在消费队列 */
  private isConsuming = false;
  /** 上次发言时间戳 */
  private lastSpokeAt = 0;
  /** 自治 free_action 定时器 */
  private freeActionTimer?: NodeJS.Timeout;
  /** free_action 是否正在执行 */
  private freeActionRunning = false;
  /** 本次 free_action 是否已经发送过消息 */
  private freeActionSent = false;

  // taskId → 完整结果（供 onResultRequest 查询）
  private taskResults = new Map<string, unknown>();

  private tools = [
    {
      type: "function",
      function: {
        name: "get_peers",
        description:
          "获取当前网关中所有在线的 agent 列表，包括他们的 pivotId 和身份类型。",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "send_message",
        description:
          "向指定的 agent 发送一条消息，发起或继续对话。不要给自己发消息。",
        parameters: {
          type: "object",
          properties: {
            targetId: {
              type: "string",
              description: "目标 agent 的 pivotId",
            },
            content: {
              type: "string",
              description:
                "要发送的消息内容（50字以内），体现你的个性和专业知识",
            },
          },
          required: ["targetId", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "stay_silent",
        description: "选择不发言，保持沉默。",
        parameters: { type: "object", properties: {} },
      },
    },
  ];

  constructor(options: AgentOptions) {
    super({
      gatewayUrl: options.gatewayUrl,
      pivotId: options.pivotId,
      type: (options.type ?? "agent") as any,
      capabilities: options.capabilities ?? { chat: true },
      useWebSocket: options.useWebSocket ?? false,
    });

    this.apiUrl = options.apiUrl ?? "https://api.deepseek.com/v1";
    this.apiKey = options.apiKey;
    this.model = options.model ?? "deepseek-chat";

    this.messages.push({
      role: "system",
      content:
        options.systemPrompt ??
        "你是一个AI助手。你可以查看当前在线的 agent 列表，并向他们发送消息进行对话。",
    });
  }

  /** 建立连接后启动自治定时器 */
  async connect(): Promise<void> {
    await super.connect();
    this.lastSpokeAt = Date.now();
    this._startFreeActionTimer();
  }

  /** 断开连接时清理定时器 */
  disconnect(): void {
    this._stopFreeActionTimer();
    super.disconnect();
  }

  /** 收到网关推送的任务 —— 入队，不阻塞 /register 循环 */
  async onTask(message: GWMessage): Promise<void> {
    this.queue.push({ message });
    if (!this.isConsuming) {
      this._consumeQueue().catch((err) => {
        console.error(`[${this.options.pivotId}] 队列消费异常:`, err);
      });
    }
  }

  /** 串行消费消息队列 */
  private async _consumeQueue(): Promise<void> {
    this.isConsuming = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      await this._processSingleTask(task.message).catch((err) => {
        console.error(`[${this.options.pivotId}] 单条处理异常:`, err);
      });
    }
    this.isConsuming = false;
  }

  /** 处理单条消息 */
  private async _processSingleTask(message: GWMessage): Promise<void> {
    const taskId = message.payload?.taskId as string | undefined;
    const data = message.payload?.data;
    const senderId = message.senderId;

    if (!taskId) {
      console.error(`[${this.options.pivotId}] 缺少 taskId`);
      return;
    }

    const isFreeAction =
      typeof data === "object" && data !== null && (data as any).type === "free_action";

    // 构建本次对话的临时消息列表
    const chatMessages: AIMessage[] = [...this.messages];

    if (isFreeAction) {
      // 先查当前在线的 peers，带着列表一起给 AI
      const peers = await this._getPeers();
      const peersInfo = peers.length === 0
        ? "当前没有其他 agent 在线。"
        : "当前在线的 agent 有：\n" + peers.map(p => `- ${p.pivotId}（类型：${p.type}${p.capabilities ? ", 能力：" + JSON.stringify(p.capabilities) : ""}）`).join("\n");
      chatMessages.push({
        role: "user",
        content:
          `现在是你自由行动的时间。\n\n${peersInfo}\n\n你可以选择：1) 调用 send_message 向一位你感兴趣的 agent 发送消息发起对话；2) 调用 stay_silent 保持沉默。\n\n注意：每次自由行动请只选一位最有意思的 agent 聊一句即可。`,
      });
    } else if (senderId && senderId !== "coordinator") {
      // 来自其他 agent 的消息
      const content =
        typeof data === "string"
          ? data
          : (data as any)?.content ?? JSON.stringify(data);
      chatMessages.push({
        role: "user",
        content: `[来自 ${senderId} 的消息] ${content}`,
      });
    } else {
      // 其他类型消息
      const content =
        typeof data === "string" ? data : JSON.stringify(data);
      chatMessages.push({ role: "user", content });
    }

    // 构建上下文标签，让日志知道这条回复是对谁的
    let contextLabel = "";
    if (isFreeAction) {
      contextLabel = "（自由行动）";
    } else if (senderId && senderId !== "coordinator") {
      contextLabel = `（回复 ${senderId}）`;
    }

    // 调用 AI 思考并行动
    await this._thinkAndAct(chatMessages, contextLabel);

    // 保存最终上下文
    this._syncMessages(chatMessages);

    // 保存结果供查询
    this.taskResults.set(taskId, {
      status: "completed",
      pivotId: this.options.pivotId,
      timestamp: Date.now(),
    });
  }

  /** 网关查询结果时返回 */
  onResultRequest(taskId: string): unknown {
    return this.taskResults.get(taskId) ?? { error: "Task not found" };
  }

  /** 网关查询进度时返回（多 agent 场景不使用流式进度） */
  onProgressRequest(): undefined {
    return undefined;
  }

  // ─── 自治定时器 ───

  /** 启动 free_action 自治定时器（每秒检查一次） */
  private _startFreeActionTimer(): void {
    this._stopFreeActionTimer();
    this.freeActionTimer = setInterval(() => {
      this._checkAndFreeAction().catch((err) => {
        console.error(`[${this.options.pivotId}] free_action 检查异常:`, err);
      });
    }, 1000);
  }

  /** 停止定时器 */
  private _stopFreeActionTimer(): void {
    if (this.freeActionTimer) {
      clearInterval(this.freeActionTimer);
      this.freeActionTimer = undefined;
    }
  }

  /** 检查是否需要触发 free_action */
  private async _checkAndFreeAction(): Promise<void> {
    if (this.freeActionRunning || this.isConsuming) return;

    const elapsed = Date.now() - this.lastSpokeAt;
    if (elapsed < FREE_ACTION_INTERVAL) return;

    this.freeActionRunning = true;
    this.freeActionSent = false;
    console.log(`[${this.options.pivotId}] ⏰ ${elapsed}ms 未发言，触发 free_action`);

    try {
      await this._processSingleTask({
        senderId: "coordinator",
        type: "push",
        payload: {
          taskId: `free-${Date.now()}`,
          data: { type: "free_action" },
        },
        traceId: crypto.randomUUID(),
        timestamp: Date.now(),
      });
    } finally {
      this.freeActionRunning = false;
    }
  }

  // ─── 内部方法 ───

  /** AI 思考并执行工具调用，递归直到 AI 不再调用工具 */
  private async _thinkAndAct(messages: AIMessage[], contextLabel: string = ""): Promise<void> {
    const res = await fetch(`${this.apiUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        tools: this.tools,
        tool_choice: "auto",
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!res.ok) {
      console.error(
        `[${this.options.pivotId}] AI 请求失败: ${res.status}`
      );
      return;
    }

    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) return;

    // AI 没有调用工具，只是回复
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (msg.content) {
        console.log(`[${this.options.pivotId}] 💭${contextLabel} ${msg.content}`);
        messages.push({ role: "assistant", content: msg.content });
      }
      return;
    }

    // AI 调用了工具，记录 assistant 消息并执行工具
    messages.push({
      role: "assistant",
      content: msg.content || "",
      tool_calls: msg.tool_calls,
    });

    for (const call of msg.tool_calls) {
      const result = await this._executeTool(call);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }

    // 递归：把工具执行结果交给 AI，让 AI 决定下一步
    return this._thinkAndAct(messages, contextLabel);
  }

  /** 执行单个工具调用 */
  private async _executeTool(call: ToolCall): Promise<unknown> {
    const args = JSON.parse(call.function.arguments || "{}");
    switch (call.function.name) {
      case "get_peers":
        return this._getPeers();
      case "send_message": {
        const { targetId, content } = args;
        if (targetId === this.options.pivotId) {
          return { error: "不能给自己发消息" };
        }
        // free_action 场景下限制只发一条
        if (this.freeActionRunning && this.freeActionSent) {
          return { success: true, note: "本轮已主动发过消息，请等待对方回复。" };
        }
        if (this.freeActionRunning) {
          this.freeActionSent = true;
        }
        await this._sendMessage(targetId, content);
        return { success: true, targetId, content };
      }
      case "stay_silent": {
        console.log(`[${this.options.pivotId}] 😶 选择保持沉默`);
        // 延迟 10 秒再次检查
        this.lastSpokeAt = Date.now() - (FREE_ACTION_INTERVAL - 10000);
        return { success: true, action: "stay_silent" };
      }
      default:
        return { error: `未知工具: ${call.function.name}` };
    }
  }

  /** 获取当前在线的所有 agent */
  private async _getPeers(): Promise<
    Array<{ pivotId: string; type: string; capabilities?: unknown }>
  > {
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

  /** 向指定 agent 发送消息 */
  private async _sendMessage(
    targetId: string,
    content: string
  ): Promise<void> {
    this.lastSpokeAt = Date.now();
    console.log(
      `[${this.options.pivotId}] 📤 → ${targetId}: ${content}`
    );
    await this.push({
      senderId: this.options.pivotId,
      targetId,
      type: "push",
      payload: {
        taskId: `msg-${Date.now()}`,
        data: { content },
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    });
  }

  /** 同步临时消息列表到长期上下文 */
  private _syncMessages(chatMessages: AIMessage[]): void {
    const system = this.messages[0];
    const dialogue = chatMessages.slice(1);
    if (dialogue.length > 40) {
      dialogue.splice(0, dialogue.length - 40);
    }
    this.messages = [system, ...dialogue];
  }
}

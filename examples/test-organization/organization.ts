/**
 * 组织网关（Organization）
 * - 继承 AgentSDK，type: "gateway"
 * - 包含 leader（决策者）+ members（提供意见的成员）
 * - 收到外部消息时：内部讨论 → leader 综合 → 统一回复
 * - 收到广播消息时：只做记录，不回复
 * - 支持禁言（收到禁言广播后一段时间内不响应）
 * - 自治定时器：15 秒未发言自动找人聊天
 */

import { AgentSDK, type AgentSDKOptions, type AIMessage } from "./agent-sdk.ts";
import { Person } from "./person.ts";
import type { Message as GWMessage } from "../../src/protocol/message.ts";

export interface OrganizationOptions extends Omit<AgentSDKOptions, "type"> {
  /** 组织名称 */
  name: string;
  /** 决策者 */
  leader: Person;
  /** 成员列表（提供意见） */
  members: Person[];
  /** 组织角色定位的 system prompt（覆盖默认） */
  systemPrompt?: string;
  /** 是否具备事件转发/扩散权限（如应急管理局） */
  canRelay?: boolean;
}

const FREE_ACTION_INTERVAL = 15000;

export class Organization extends AgentSDK {
  readonly name: string;
  readonly leader: Person;
  readonly members: Person[];
  /** 是否具备事件转发/扩散权限 */
  private canRelay: boolean;

  /** 上次发言时间戳 */
  private lastSpokeAt = 0;
  /** 自治定时器 */
  private freeActionTimer?: NodeJS.Timeout;
  /** free_action 是否正在执行 */
  private freeActionRunning = false;
  /** 本次 free_action 是否已发送消息 */
  private freeActionSent = false;
  /** 禁言截止时间戳（0 表示未禁言） */
  private mutedUntil = 0;
  /** AI 消息历史（供 leader 使用） */
  private messages: AIMessage[] = [];

  constructor(options: OrganizationOptions) {
    super({
      ...options,
      type: "gateway",
    });

    this.name = options.name;
    this.leader = options.leader;
    this.members = options.members;
    this.canRelay = options.canRelay ?? false;

    const defaultPrompt = `你是${this.name}的对外发言人。
你的组织收到外部消息后，会先内部讨论形成统一意见，然后由你对外回复。
回复时请保持组织立场一致，体现专业性。`;
    this.messages.push({
      role: "system",
      content: options.systemPrompt ?? defaultPrompt,
    });
  }

  /** 建立连接后启动自治定时器 */
  async connect(): Promise<void> {
    await super.connect();
    this.lastSpokeAt = Date.now();
    this._startFreeActionTimer();
    // 打印组织人员信息
    const roster = this.members
      .map((m) => `  - ${m.name}: ${m.role}`)
      .join("\n");
    this._log(`[${this.name}] 当前组织人员信息\n${roster}`);
  }

  /** 断开连接时清理 */
  disconnect(): void {
    this._stopFreeActionTimer();
    super.disconnect();
  }

  /** 收到网关推送的任务 */
  async onTask(message: GWMessage): Promise<void> {
    const data = message.payload?.data;
    const senderId = message.senderId;

    // 广播消息：只记录，不回复
    if (typeof data === "object" && data !== null && (data as any).broadcast === true) {
      await this._handleBroadcast(message);
      return;
    }

    const isFreeAction = typeof data === "object" && data !== null && (data as any).type === "free_action";
    const isMuted = Date.now() < this.mutedUntil;

    // 协议层标记：外部消息到达组织（模拟递归委托）
    if (isFreeAction) {
      this._log(
        `[Protocol] ${this.options.pivotId} → SELF(free_action)`
      );
    } else if (senderId && senderId !== "coordinator") {
      this._log(
        `[Protocol] ${this.options.pivotId} → DELEGATE(${senderId})`
      );
    }

    // 构建上下文标签
    let contextLabel = "";
    if (isFreeAction) {
      contextLabel = "（自由行动）";
    } else if (senderId && senderId !== "coordinator") {
      contextLabel = `（回复 ${senderId}）`;
    }

    if (isMuted) {
      this._log(`[${this.name}] 🔇 当前处于禁言状态，仅内部讨论不对外回复`);
    }

    // 内部讨论 → 统一回复（禁言时只讨论不发送）
    await this._discussAndReply(message, contextLabel, isFreeAction, isMuted);
  }

  // ─── 内部讨论流程 ───

  /** 内部讨论并对外回复（禁言时只讨论不发送） */
  private async _discussAndReply(
    message: GWMessage,
    contextLabel: string,
    isFreeAction: boolean,
    isMuted: boolean = false
  ): Promise<void> {
    const senderId = message.senderId;
    const data = message.payload?.data;

    let content: string;
    if (typeof data === "string") {
      content = data;
    } else if (data !== null && typeof data === "object") {
      content = (data as any)?.content ?? JSON.stringify(data);
    } else {
      content = String(data);
    }

    this._log(`\n[${this.name}] 🏢 收到外部消息${contextLabel}`);
    this._log(`[${this.name}] 📝 内容: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`);

    // Step 1: 并行收集所有成员意见
    this._log(`[${this.name}] 👥 开始内部讨论 (${this.members.length} 人)...`);
    const contextForMembers = `组织：${this.name}\n收到来自 ${senderId} 的消息：${content}\n\n请作为 ${this.name} 的成员发表你的专业意见。`;

    const opinions = await Promise.all(
      this.members.map(async (member) => {
        const opinion = await member.think(contextForMembers);
        this._log(`[${this.name}] 💬 ${member.name}: ${opinion.slice(0, 80)}${opinion.length > 80 ? "..." : ""}`);
        return { name: member.name, opinion };
      })
    );

    // Step 2: leader 综合意见，形成统一回复
    const opinionsText = opinions
      .map((o) => `- ${o.name}: ${o.opinion}`)
      .join("\n");

    const leaderContext = `你是${this.leader.name}，${this.leader.role}。\n\n组织${this.name}收到了以下外部消息：\n${content}\n\n成员意见：\n${opinionsText}\n\n请综合以上意见，形成${this.name}的统一对外回复（50-100字）。回复应体现组织立场，简洁专业。`;

    this._log(`[${this.name}] 👤 ${this.leader.name} 正在综合意见...`);
    const reply = await this.leader.think(leaderContext);

    // 协议标记：内部协商形成共识
    const memberNames = this.members.map((m) => m.name).join(", ");
    this._log(
      `[Protocol] ${this.options.pivotId} → CONSENSUS(${memberNames}, ${this.leader.name})`
    );

    // Step 3: 发送回复（禁言时只内部讨论，不对外发送）
    if (isMuted) {
      this._log(`[${this.name}] 🔇 禁言中，内部讨论完成但不对外发送`);
      this._log(
        `[Protocol] ${this.options.pivotId} → SELF(internal_discuss, suppressed)`
      );
    } else if (isFreeAction) {
      // free_action：只向其他 gateway/agent 发送，跳过 tool
      const peers = (await this._getPeers()).filter(
        (p) => p.type !== "tool"
      );
      if (peers.length > 0) {
        const target = peers[Math.floor(Math.random() * peers.length)];
        await this._sendMessage(target.pivotId, { content: reply });
        this.lastSpokeAt = Date.now();
      } else {
        this._log(`[${this.name}] 😶 没有可聊天的对象`);
      }
    } else {
      // 回复特定发件人
      if (senderId && senderId !== "coordinator") {
        await this._sendMessage(senderId, { content: reply });
        this.lastSpokeAt = Date.now();
      }
    }
  }

  // ─── 广播处理 ───

  /** 处理广播消息 */
  private async _handleBroadcast(message: GWMessage): Promise<void> {
    const data = message.payload?.data as any;
    const eventType = data?.eventType ?? "unknown";
    const eventData = data?.eventData ?? {};

    this._log(`\n[${this.name}] 📢 收到广播 [${eventType}]`);
    this._log(`[${this.name}] 📋 内容: ${JSON.stringify(eventData).slice(0, 200)}`);

    // 根据事件类型处理
    switch (eventType) {
      case "mute": {
        // 禁言
        const duration = (eventData.duration as number) ?? 60000;
        this.mutedUntil = Date.now() + duration;
        this._log(`[${this.name}] 🔇 被禁言 ${duration / 1000} 秒`);
        break;
      }
      case "unmute": {
        // 解除禁言
        this.mutedUntil = 0;
        this._log(`[${this.name}] 🔊 禁言已解除`);
        break;
      }
      case "disaster":
      case "virus":
      case "arrest":
      default: {
        // 记录事件，内部讨论但不对外回复
        const context = `紧急广播：${eventType}\n详情：${JSON.stringify(eventData)}\n\n请发表你的看法。`;
        const opinion = await this.leader.think(context);
        this._log(`[${this.name}] 💭 ${this.leader.name}: ${opinion.slice(0, 100)}${opinion.length > 100 ? "..." : ""}`);

        // 具备转发权限的组织：评估后决定是否扩散给其他组织
        if (this.canRelay) {
          await this._relayIfNeeded(eventType, eventData, opinion);
        }
        break;
      }
    }
  }

  // ─── 事件转发 ───

  /** 评估后决定是否转发事件给其他组织 */
  private async _relayIfNeeded(
    eventType: string,
    eventData: Record<string, unknown>,
    opinion: string
  ): Promise<void> {
    const assessContext = `你是${this.leader.name}。你刚对以下事件发表了看法：${opinion}\n事件：${eventType}，详情：${JSON.stringify(eventData)}\n作为具有信息发布权限的机构负责人，请你直接回答：是否需要将此事件通知给其他组织？请只回答"是"或"否"。`;
    const decision = await this.leader.think(assessContext);
    const shouldRelay =
      decision.includes("是") || decision.toLowerCase().includes("yes");

    if (!shouldRelay) {
      this._log(`[${this.name}] 🚫 ${this.leader.name} 判断无需扩散此事件`);
      return;
    }

    this._log(
      `[${this.name}] 🚨 ${this.leader.name} 判断需要扩散，正在通知其他组织...`
    );

    const peers = (await this._getPeers()).filter(
      (p) => p.type !== "tool" && p.pivotId !== this.options.pivotId
    );

    for (const peer of peers) {
      await this._sendBroadcast(peer.pivotId, eventType, {
        ...eventData,
        relayedBy: this.name,
        note: `此事件由${this.name}评估后转发`,
      });
    }
  }

  // ─── 自治定时器 ───

  /** 启动自治定时器 */
  private _startFreeActionTimer(): void {
    this._stopFreeActionTimer();
    this.freeActionTimer = setInterval(() => {
      this._checkAndFreeAction().catch((err) => {
        this._err(`[${this.name}] free_action 检查异常:`, err);
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
    if (this.freeActionRunning || Date.now() < this.mutedUntil) return;

    const elapsed = Date.now() - this.lastSpokeAt;
    if (elapsed < FREE_ACTION_INTERVAL) return;

    this.freeActionRunning = true;
    this.freeActionSent = false;
    this._log(`[${this.name}] ⏰ ${elapsed}ms 未发言，触发 free_action`);

    try {
      await this.onTask({
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
}

/**
 * 社会安全自动检测系统（AutoDetector）
 * - PivotType: "tool"
 * - 模拟城市安全监测基础设施，自动检测并上报异常事件
 * - 支持事件类型：mute / unmute / disaster / virus / arrest
 * - Agent 无需回复自动检测系统的消息
 *
 * 用法：
 *   const detector = new AutoDetector({ gatewayUrl, pivotId });
 *   await detector.connect();
 *   await detector.broadcast("disaster", { description: "地震预警" });
 */

import { AgentSDK, type AgentSDKOptions } from "./test-organization/agent-sdk.ts";
import type { Message as GWMessage } from "../sdk/type.ts";

export interface AutoDetectorOptions extends Omit<AgentSDKOptions, "type"> {
  /** 是否只发给 gateway 类型的节点，默认 true */
  gatewayOnly?: boolean;
}

export class AutoDetector extends AgentSDK {
  private gatewayOnly: boolean;

  constructor(options: AutoDetectorOptions) {
    super({
      ...options,
      type: "tool",
    });
    this.gatewayOnly = options.gatewayOnly ?? true;
  }

  /** 建立连接并输出背景说明 */
  async connect(): Promise<void> {
    await super.connect();
    this._log(`[自动检测系统] 今天是风和日丽的一天`);
  }

  /** 自动检测系统不处理任何外部消息 */
  async onTask(_message: GWMessage): Promise<void> {
    // no-op
  }

  /**
   * 向所有在线目标发送广播
   * @param eventType - 事件类型：mute / unmute / disaster / virus / arrest
   * @param eventData - 事件数据
   * @param filter - 可选：基于 capabilities 过滤目标
   */
  async broadcast(
    eventType: string,
    eventData: Record<string, unknown> = {},
    filter?: (capabilities?: Record<string, unknown>) => boolean
  ): Promise<number> {
    let peers = await this._getPeers();
    if (this.gatewayOnly) {
      peers = peers.filter((p) => p.type === "gateway");
    }
    if (filter) {
      peers = peers.filter((p) => filter(p.capabilities as Record<string, unknown> | undefined));
    }

    if (peers.length === 0) {
      this._log(`[AutoDetector] ⚠️ 没有可广播的目标`);
      return 0;
    }

    this._log(
      `[AutoDetector] 📢 自动检测系统上报 [${eventType}] → ${peers.length} 个目标`
    );

    for (const target of peers) {
      await this._sendBroadcast(target.pivotId, eventType, eventData);
    }

    return peers.length;
  }

  /**
   * 按 capabilities 键值过滤后广播
   */
  async broadcastTo(
    eventType: string,
    eventData: Record<string, unknown>,
    capabilityKey: string,
    capabilityValue: unknown
  ): Promise<number> {
    return this.broadcast(eventType, eventData, (caps) =>
      caps?.[capabilityKey] === capabilityValue
    );
  }

  /** 禁言所有目标 */
  async mute(durationMs: number = 60000): Promise<number> {
    return this.broadcast("mute", { duration: durationMs });
  }

  /** 解除禁言 */
  async unmute(): Promise<number> {
    return this.broadcast("unmute", {});
  }

  /** 发送灾难预警 */
  async disaster(description: string): Promise<number> {
    return this.broadcast("disaster", { description });
  }

  /** 发送病毒警报 */
  async virus(description: string): Promise<number> {
    return this.broadcast("virus", { description });
  }

  /** 发送逮捕/管制通知 */
  async arrest(target: string, reason: string): Promise<number> {
    return this.broadcast("arrest", { target, reason });
  }
}

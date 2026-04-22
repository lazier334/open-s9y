import { BasePivot } from "../src/client/base-pivot.ts";
import type { Message } from "../src/protocol/message.ts";
import type { GatewayServer } from "../src/core/server.ts";

interface PivotRecord {
  pivotId: string;
  type: string;
  capabilities: Record<string, unknown>;
  assignedCount: number;
}

/**
 * 路由插件 Pivot（本地模式）
 * - 继承 BasePivot，localMode=true
 * - 直接通过 gateway.connections 获取在线支点
 * - 实现能力匹配 + 最小负载均衡
 */
export class RouterPivot extends BasePivot {
  private gateway: GatewayServer;
  private assignedCounts = new Map<string, number>();

  constructor(options: {
    pivotId: string;
    type: "system";
    capabilities?: Record<string, unknown>;
    gateway: GatewayServer;
  }) {
    super({
      gatewayUrl: "local://internal",
      pivotId: options.pivotId,
      type: options.type,
      capabilities: options.capabilities,
      localMode: true,
    });
    this.gateway = options.gateway;
  }

  async connect(): Promise<void> {
    // localMode，无需网络连接
    return Promise.resolve();
  }

  /**
   * 任务分发决策
   * - 从 message.payload.capabilities 提取所需能力
   * - 通过 gateway.connections 获取实时在线支点
   * - 选择 assignedCount 最小的支点
   */
  async onTask(message: Message): Promise<string> {
    const rawCap = message.payload?.capabilities;
    const capability = typeof rawCap === "string" ? rawCap : "default";

    const all = this.gateway.getAllPivots();
    const candidates: PivotRecord[] = [];

    for (const pivot of all) {
      const caps = pivot.capabilities ?? {};
      if (capability === "default" || caps[capability] === true || caps.capability === capability) {
        candidates.push({
          pivotId: pivot.pivotId,
          type: pivot.type ?? "other",
          capabilities: caps,
          assignedCount: this.assignedCounts.get(pivot.pivotId) ?? 0,
        });
      }
    }

    if (candidates.length === 0) {
      throw new Error(`没有可用支点支持该能力: ${capability}`);
    }

    const selected = candidates.sort((a, b) => a.assignedCount - b.assignedCount)[0];
    this.assignedCounts.set(selected.pivotId, selected.assignedCount + 1);
    return selected.pivotId;
  }
}

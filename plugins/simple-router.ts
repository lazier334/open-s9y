import type { GatewayPlugin } from "../src/plugin/interface.ts";
import type { GatewayAPI, Message, PivotInfo, Status } from "../src/protocol/message.ts";

interface PivotRecord {
  pivotId: string;
  type: string;
  capabilities: Record<string, unknown>;
  status: Status;
  assignedCount: number;
}

/**
 * 简单轮询路由插件
 * - 根据 message.payload.capability 匹配支点能力
 * - 在候选者中选择负载最低（assignedCount 最小）的支点
 */
export class SimpleRouterPlugin implements GatewayPlugin {
  private gatewayAPI?: GatewayAPI;
  private pivots = new Map<string, PivotRecord>();

  /**
   * 初始化插件，保存网关 API 引用
   * @param gatewayAPI - 网关暴露给插件的 API 对象
   */
  initialize(gatewayAPI: GatewayAPI): void {
    this.gatewayAPI = gatewayAPI;
  }

  /**
   * 新支点连接时的处理逻辑
   * - 将支点信息存入内部 Map
   * - 若已存在则更新信息，保留 assignedCount
   * @param pivotInfo - 支点注册信息
   * @returns 固定返回 true，表示接受所有支点
   */
  onPivotConnect(pivotInfo: PivotInfo): boolean {
    const existing = this.pivots.get(pivotInfo.pivotId);
    this.pivots.set(pivotInfo.pivotId, {
      pivotId: pivotInfo.pivotId,
      type: pivotInfo.type ?? "other",
      capabilities: pivotInfo.capabilities ?? {},
      status: existing?.status ?? {
        connectedAt: Date.now(),
        lastHeartbeatAt: Date.now(),
      },
      assignedCount: existing?.assignedCount ?? 0,
    });
    return true;
  }

  /**
   * 支点断开时的处理逻辑
   * - 保留在内部 Map 中（缓存有效期内仍可用于负载均衡）
   * - 仅更新最后活跃时间
   * @param pivotId - 断开连接的支点 ID
   */
  onPivotDisconnect(pivotId: string): void {
    const pivot = this.pivots.get(pivotId);
    if (pivot) {
      pivot.status = { ...pivot.status, lastHeartbeatAt: Date.now() };
    }
  }

  /**
   * 支点心跳更新时的处理逻辑
   * - 同步更新内部保存的 status 状态
   * @param pivotId - 支点 ID
   * @param status - 最新的状态对象
   */
  onPivotUpdate(pivotId: string, status: Status): void {
    const pivot = this.pivots.get(pivotId);
    if (pivot) {
      pivot.status = status;
    }
  }

  /**
   * 核心任务分发决策
   * - 从 message.payload.capabilities 提取所需能力
   * - 遍历所有在线支点，筛选匹配 capability 的候选者
   * - 选择 assignedCount 最小的支点（简单负载均衡）
   * @param message - 用户提交的任务消息
   * @returns 被选中的支点 ID
   * @throws 没有可用支点时抛出错误
   */
  async onTaskSubmit(message: Message): Promise<string> {
    const rawCap = message.payload?.capabilities;
    const capability = typeof rawCap === "string" ? rawCap : "default";
    const candidates: PivotRecord[] = [];

    for (const pivot of this.pivots.values()) {
      const caps = pivot.capabilities;
      if (capability === "default" || caps[capability] === true || caps.capability === capability) {
        candidates.push(pivot);
      }
    }

    if (candidates.length === 0) {
      throw new Error(`没有可用支点支持该能力: ${capability}`);
    }

    // 选择 assignedCount 最小的支点（简单负载均衡）
    const selected = candidates.sort((a, b) => a.assignedCount - b.assignedCount)[0];
    return selected.pivotId;
  }

  /**
   * 任务成功路由后的回调
   * - 增加被选中支点的 assignedCount，用于后续负载均衡计算
   * @param taskId - 任务唯一标识
   * @param pivotId - 被分配到的支点 ID
   */
  onTaskAssigned(taskId: string, pivotId: string): void {
    const pivot = this.pivots.get(pivotId);
    if (pivot) {
      pivot.assignedCount++;
    }
  }
}

import type { GatewayAPI, Message, PivotInfo, Status } from "../protocol/message.ts";

/**
 * 网关插件接口定义
 * 插件职责最小化：仅处理首次任务分发，以及支点的生命周期回调
 */
export interface GatewayPlugin {
  /** 初始化插件，注入网关 API */
  initialize(gatewayAPI: GatewayAPI): void;

  /** 支点连接时触发，返回是否接受该支点 */
  onPivotConnect(pivotInfo: PivotInfo): boolean;

  /** 支点断开时触发 */
  onPivotDisconnect(pivotId: string): void;

  /** 支点心跳更新时触发 */
  onPivotUpdate(pivotId: string, status: Status): void;

  /** 核心：任务分发决策，返回选中的 pivotId */
  onTaskSubmit(message: Message): Promise<string>;

  /** 可选：记录路由（用于后续优化） */
  onTaskAssigned?(taskId: string, pivotId: string): void;
}

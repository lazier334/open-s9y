/**
 * 统一消息格式定义
 * 所有传输层协议（HTTP / WebSocket）最终都转换为 Message 在内部流转
 */

export type MessageType = "push" | "progress" | "result" | "register" | "heartbeat";

export type PivotType = "user-end" | "agent" | "system" | "gateway" | "other";

export interface MessagePayload {
  taskId?: string;
  data?: unknown;
  capabilities?: Record<string, unknown> | string;
  error?: string;
  status?: string;
  // register 消息额外字段
  pivotId?: string;
  type?: PivotType;
}

export interface Message {
  /** 发送方支点ID */
  senderId: string;
  /** 目标支点ID（插件填写） */
  targetId?: string;
  /** 消息类型 */
  type: MessageType;
  /** 载荷 */
  payload: MessagePayload;
  /** 全链路追踪ID */
  traceId: string;
  /** 时间戳 */
  timestamp: number;
}

export interface PivotInfo {
  pivotId: string;
  type: PivotType;
  capabilities?: Record<string, unknown>;
}

export interface Status {
  connectedAt: number;
  lastHeartbeatAt: number;
  load?: number;
}

/**
 * 网关对外暴露的 API，供插件调用
 */
export interface GatewayAPI {
  /** 向指定支点推送消息 */
  routeTo(pivotId: string, message: Message): Promise<void>;
  /** 向指定支点请求流式进度 */
  openStream(pivotId: string, message: Message): ReadableStream;
  /** 向指定支点请求结果 */
  requestTo(pivotId: string, message: Message): Promise<unknown>;
}

import type { Message } from "./message.ts";

/**
 * 将 WebSocket 原始消息解析为内部 Message 格式
 * @param raw - WebSocket 收到的原始数据（Buffer / ArrayBuffer / Buffer 数组）
 * @returns 合法的 Message 对象；解析失败或缺少必要字段时返回 null
 */
export function parseWsMessage(raw: Buffer | ArrayBuffer | Buffer[]): Message | null {
  try {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString() : raw.toString();
    const parsed = JSON.parse(text) as Partial<Message>;
    if (!parsed.senderId || !parsed.type) return null;
    return {
      senderId: parsed.senderId,
      targetId: parsed.targetId,
      type: parsed.type,
      payload: parsed.payload ?? {},
      traceId: parsed.traceId ?? crypto.randomUUID(),
      timestamp: parsed.timestamp ?? Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * 将 Message 序列化为 WebSocket 发送文本
 * @param message - 内部 Message 对象
 * @returns JSON 字符串
 */
export function serializeMessage(message: Message): string {
  return JSON.stringify(message);
}

import type { Message } from "./message.ts";

/**
 * 将 HTTP 请求体解析为内部 Message 格式
 * @param body - HTTP 请求体（通常为 JSON 解析后的对象）
 * @returns 合法的 Message 对象；若缺少必要字段则返回 null
 */
export function parseHttpBodyToMessage(body: unknown): Message | null {
  if (!body || typeof body !== "object") return null;
  const msg = body as Partial<Message>;
  if (!msg.senderId || !msg.type) return null;
  return {
    senderId: msg.senderId,
    targetId: msg.targetId,
    type: msg.type,
    payload: msg.payload ?? {},
    traceId: msg.traceId ?? crypto.randomUUID(),
    timestamp: msg.timestamp ?? Date.now(),
  };
}

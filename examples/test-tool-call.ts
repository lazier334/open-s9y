/**
 * 工具直接调用测试示例
 * - 向网关发送 /push，通过 capabilities 让插件自动匹配工具
 * - payload.sync=true 触发同步模式，网关等待工具响应后返回
 * - 无需 targetId，无需 pipe 查询
 *
 * 运行方式：
 *   node --experimental-strip-types examples/test-tool-call.ts
 */

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";
const senderId = `test-tool-user-${Date.now()}`;

async function main() {
  const getRandomInt = (max: number) => Math.floor(Math.random() * max);
  const payload = {
    content: "计算数字相加", numbers: [
      getRandomInt(100),
      getRandomInt(100),
      getRandomInt(100),
      getRandomInt(100),
      getRandomInt(100),
      '测试123',
      '222'
    ]
  };

  console.log(`[TestToolCall] 调用工具 (capabilities=calc):`, JSON.stringify(payload));

  const res = await fetch(`${gatewayUrl}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      senderId,
      type: "push",
      payload: {
        taskId: `tool-task-${Date.now()}`,
        data: payload,
        capabilities: "calc",
        sync: true,
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    }),
  });

  if (!res.ok) {
    console.error("[TestToolCall] 调用失败:", res.status, await res.text());
    process.exit(1);
  }

  const result = (await res.json()) as unknown;
  console.log("[TestToolCall] 结果:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[TestToolCall] 异常:", err);
  process.exit(1);
});

/**
 * 伪用户客户端示例
 * - 通过 HTTP 向网关提交任务
 * - GET /pipe?taskId=...&protocol=progress 挂起等待流式进度数据
 * - GET /pipe?taskId=...&protocol=result 挂起等待结果数据
 *
 * 运行方式：
 *   node --experimental-strip-types examples/fake-user.ts "帮我写一首诗"
 */

const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";
const content = process.argv[2] ?? "你好，世界";
// const taskId = `task-${Date.now()}`;
const taskId = `task-123`;
const senderId = `fake-user-${Date.now()}`;

async function main() {
  console.log(`[FakeUser] 准备发送任务: "${content}"`);

  // 1. 提交任务
  const pushRes = await fetch(`${gatewayUrl}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      senderId,
      type: "push",
      payload: {
        taskId,
        data: { content },
        capabilities: "chat",
      },
      traceId: crypto.randomUUID(),
      timestamp: Date.now(),
    }),
  });

  if (!pushRes.ok) {
    console.error("[FakeUser] 提交任务失败:", await pushRes.text());
    process.exit(1);
  }

  const pushBody = (await pushRes.json()) as { status: string; taskId: string };
  console.log(`[FakeUser] 任务已提交:`, pushBody);

  // NOTE 因为目前代码未处理支点短时间不在线的问题，所以需要等待
  await delay(200)
  // 2. 挂起读取进度（流式实时输出）
  console.log("[FakeUser] --- 开始读取进度 ---");
  console.log(`${gatewayUrl}/pipe?taskId=${taskId}&protocol=progress`);
  const progressRes = await fetch(`${gatewayUrl}/pipe?taskId=${taskId}&protocol=progress`);
  if (progressRes.ok && progressRes.body) {
    const reader = progressRes.body.getReader();
    const decoder = new TextDecoder();
    console.log('--- 开始实时输出 ---\n');
    try {

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          // 直接解码输出，无需解析帧头
          const text = decoder.decode(value, { stream: true });
          process.stdout.write(text);
        }
        if (done) {
          // 刷新剩余
          const final = decoder.decode(new Uint8Array(0), { stream: false });
          if (final) process.stdout.write(final);
          console.log('\n\n[完成] 传输结束');
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    console.error("[FakeUser] 进度读取失败:", progressRes.status, await progressRes.text());
  }

  // NOTE 因为目前代码未处理支点短时间不在线的问题，所以需要等待
  await delay(200)
  // 3. 挂起读取结果
  console.log("[FakeUser] --- 开始读取结果 ---");
  console.log(`${gatewayUrl}/pipe?taskId=${taskId}&protocol=result`);

  const resultRes = await fetch(`${gatewayUrl}/pipe?taskId=${taskId}&protocol=result`);
  if (resultRes.ok) {
    const resultBody = (await resultRes.json()) as { taskId: string; data: unknown };
    console.log("[FakeUser] 最终结果:", JSON.stringify(resultBody.data, null, 2));
  } else {
    console.error("[FakeUser] 读取结果失败:", resultRes.status, await resultRes.text());
  }
}
function delay(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)) };
main().catch((err) => {
  console.error("[FakeUser] 异常:", err);
  process.exit(1);
});

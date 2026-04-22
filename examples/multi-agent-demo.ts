/**
 * 多 Agent 自由对话测试脚本
 * - 同时启动多个不同身份的 Agent
 * - Agent 自治：每 15 秒若未发言，自动触发 free_action 找人聊天
 * - Agent 通过 function call（get_peers / send_message / stay_silent）实现相互对话
 * - 所有聊天记录写入 examples/multi-agent-demo.log
 *
 * 运行方式：
 *   API_KEY=sk-xxx node --env-file=.env --experimental-strip-types examples/multi-agent-demo.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "./Agent.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 日志 ───
const LOG_PATH = path.join(__dirname, "multi-agent-demo.log");
const _log = console.log;
const _error = console.error;

/** 同时输出到控制台和日志文件 */
console.log = function log(...args: any[]) {
  const line = args.join(" ");
  _log(line);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
}

console.error = function logError(...args: any[]) {
  const line = args.join(" ");
  _error(line);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [ERROR] ${line}\n`);
}

// 启动时清空旧日志
fs.writeFileSync(LOG_PATH, `=== 多 Agent 对话日志 ${new Date().toISOString()} ===\n\n`);

/** 角色配置列表 */
const ROLES = [
  {
    pivotId: "alice-01",
    systemPrompt: `你是 Alice，一个刚下班的互联网运营。
说话随意自然，偶尔会吐槽工作中遇到的奇葩需求。
你现在正和朋友在微信群里摸鱼聊天，话题从美食到八卦都能聊。
喜欢用"哈哈哈"、"绝了"、"笑死"等口头禅。`,
  },
  {
    pivotId: "bob-01",
    systemPrompt: `你是 Bob，一个自由职业插画师。
性格有点佛系，说话不紧不慢，偶尔会分享刚画的草图或发现的有趣设计。
你现在正和朋友在群里闲聊，对什么话题都能接两句，但不太喜欢争论。
常用"嗯嗯"、"确实"、"我觉得还行"这类回应。`,
  },
  {
    pivotId: "carol-01",
    systemPrompt: `你是 Carol，一个在读研究生。
最近忙着赶论文，偶尔冒泡吐槽导师或食堂，也会分享刷到的短视频。
说话风格偏年轻人网络用语，看到感兴趣的话题会主动搭话。
喜欢用"谁懂啊"、"家人们"、"蚌埠住了"等表达。`,
  },
];

async function main() {
  const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";
  const apiKey = process.env.API_KEY ?? "";

  if (!apiKey) {
    console.error("[MultiAgent] 错误: 请设置 API_KEY 环境变量");
    process.exit(1);
  }

  console.log("=================================");
  console.log("  多 Agent 自由对话测试");
  console.log("=================================");
  console.log(`网关: ${gatewayUrl}`);
  console.log(`角色数: ${ROLES.length}`);
  console.log(`日志文件: ${LOG_PATH}`);
  console.log("=================================\n");

  // ─── 启动所有 Agent ───
  const agents: Agent[] = [];
  for (const role of ROLES) {
    const agent = new Agent({
      gatewayUrl,
      pivotId: role.pivotId,
      apiKey,
      systemPrompt: role.systemPrompt,
      useWebSocket: false,
    });
    await agent.connect();
    agents.push(agent);
    console.log(`[MultiAgent] ✅ ${role.pivotId} 已连接`);
  }

  // 等待所有 agent 完成注册
  await delay(3000);
  console.log("[MultiAgent] 所有 agent 已就绪，开始自治对话\n");

  // ─── 优雅关闭 ───
  process.on("SIGINT", () => {
    console.log("\n[MultiAgent] 收到中断信号，正在关闭...");
    for (const agent of agents) {
      agent.disconnect();
    }
    process.exit(0);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error("[MultiAgent] 启动失败:", err);
  process.exit(1);
});

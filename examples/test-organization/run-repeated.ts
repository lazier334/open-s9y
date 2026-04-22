/**
 * 可重复性实验运行器
 * - 多次运行 demo，每次生成独立日志
 * - temperature=0 确保输出确定性
 * - 汇总统计：各组织发言次数、交互次数、广播响应数
 *
 * 运行方式：
 *   API_KEY=sk-xxx node --env-file=.env --experimental-strip-types examples/test-organization/run-repeated.ts [次数]
 *
 * 输出：
 *   examples/test-organization/runs/run-1.log
 *   examples/test-organization/runs/run-2.log
 *   ...
 *   examples/test-organization/runs/summary.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RUNS_DIR = path.join(__dirname, "runs");
const DEMO_SCRIPT = path.join(__dirname, "demo.ts");

const apiKey = process.env.API_KEY ?? "";
if (!apiKey) {
  console.error("[RunRepeated] 错误: 请设置 API_KEY 环境变量");
  process.exit(1);
}

const runCount = parseInt(process.argv[2] ?? "3", 10);
if (runCount < 1 || runCount > 20) {
  console.error("[RunRepeated] 错误: 运行次数需在 1-20 之间");
  process.exit(1);
}

// 确保输出目录存在
fs.mkdirSync(RUNS_DIR, { recursive: true });

interface RunResult {
  runId: number;
  logPath: string;         // stdout/stderr 捕获日志
  demoLogPath: string;     // demo.ts 带时间戳的独立日志
  messageCount: Record<string, number>;
  broadcastResponses: number;
  freeActions: number;
  crossOrgMessages: number;
  durationSec: number;
}

async function runSingle(runId: number): Promise<RunResult> {
  const logPath = path.join(RUNS_DIR, `run-${runId}.log`);
  const startTime = Date.now();

  console.log(`\n[RunRepeated] ─── 运行 #${runId} / ${runCount} ───`);

  return new Promise((resolve, reject) => {
    // 为每次运行指定独立的 demo 日志文件
    const demoLogPath = path.join(RUNS_DIR, `demo-${runId}.log`);

    const child = spawn(
      "node",
      [
        "--env-file=.env",
        "--experimental-strip-types",
        DEMO_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          API_KEY: apiKey,
          TOTAL_RUN_TIME: "180000",
          NODE_NO_WARNINGS: "1",
          DEMO_LOG_PATH: demoLogPath,
        },
        cwd: path.resolve(__dirname, "../.."),
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      const durationSec = (Date.now() - startTime) / 1000;
      const combined = stdout + stderr;

      fs.writeFileSync(logPath, combined);

      // 统计
      const messageCount: Record<string, number> = {};
      const orgNames = ["星辰科技", "市应急管理局", "都市报编辑部", "市红十字会"];
      for (const name of orgNames) {
        const regex = new RegExp(`\\[${name}\\]`, "g");
        const matches = combined.match(regex);
        messageCount[name] = matches?.length ?? 0;
      }

      const broadcastResponses =
        (combined.match(/收到广播/g) ?? []).length;
      const freeActions =
        (combined.match(/触发 free_action/g) ?? []).length;
      const crossOrgMessages =
        (combined.match(/📤 → /g) ?? []).length;

      const result: RunResult = {
        runId,
        logPath,
        demoLogPath,
        messageCount,
        broadcastResponses,
        freeActions,
        crossOrgMessages,
        durationSec,
      };

      console.log(
        `[RunRepeated] #${runId} 完成 | 用时 ${durationSec.toFixed(1)}s | ` +
          `广播响应 ${broadcastResponses} | free_action ${freeActions} | ` +
          `跨组织消息 ${crossOrgMessages}`
      );
      console.log(
        `  - stdout 日志: ${logPath}`
      );
      console.log(
        `  - demo 日志:  ${demoLogPath}`
      );

      if (code !== 0 && code !== null) {
        console.warn(`[RunRepeated] #${runId} 退出码非零: ${code}`);
      }

      resolve(result);
    });

    child.on("error", reject);
  });
}

function writeSummary(results: RunResult[]): void {
  const summaryPath = path.join(RUNS_DIR, "summary.json");

  const avgDuration =
    results.reduce((s, r) => s + r.durationSec, 0) / results.length;
  const avgBroadcast =
    results.reduce((s, r) => s + r.broadcastResponses, 0) / results.length;
  const avgFreeActions =
    results.reduce((s, r) => s + r.freeActions, 0) / results.length;
  const avgCrossOrg =
    results.reduce((s, r) => s + r.crossOrgMessages, 0) / results.length;

  const orgAvgMessages: Record<string, number> = {};
  const orgNames = ["星辰科技", "市应急管理局", "都市报编辑部", "市红十字会"];
  for (const name of orgNames) {
    orgAvgMessages[name] =
      results.reduce((s, r) => s + (r.messageCount[name] ?? 0), 0) /
      results.length;
  }

  const summary = {
    meta: {
      runCount: results.length,
      timestamp: new Date().toISOString(),
      temperature: 0,
      totalRunTimeSec: 120,
    },
    averages: {
      durationSec: avgDuration,
      broadcastResponses: avgBroadcast,
      freeActions: avgFreeActions,
      crossOrgMessages: avgCrossOrg,
      messagesPerOrg: orgAvgMessages,
    },
    runs: results,
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n[RunRepeated] 汇总已保存: ${summaryPath}`);
}

async function main() {
  console.log("=================================");
  console.log("  可重复性实验运行器");
  console.log("=================================");
  console.log(`运行次数: ${runCount}`);
  console.log(`temperature: 0`);
  console.log(`单次上限: 180 秒`);
  console.log(`输出目录: ${RUNS_DIR}`);
  console.log("=================================");

  const results: RunResult[] = [];

  for (let i = 1; i <= runCount; i++) {
    const result = await runSingle(i);
    results.push(result);
    if (i < runCount) {
      console.log("[RunRepeated] 等待 2 秒后开始下一轮...");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  writeSummary(results);

  console.log("\n[RunRepeated] ✅ 全部完成");
}

main().catch((err) => {
  console.error("[RunRepeated] 运行失败:", err);
  process.exit(1);
});

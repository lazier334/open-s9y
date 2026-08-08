/**
 * 公共测试结果模块
 *
 * 统一测试输出格式，并将结果保存到 tests/logs/ 目录。
 *
 * 使用：
 *   import { test, summary } from "./lib/result.ts";
 *   await test("测试项名称", "需求描述", async () => { ... });
 *   summary();
 */

import fs from "node:fs";
import path from "node:path";

interface TestRecord {
  name: string;
  requirement: string;
  passed: boolean;
  detail: string;
}

const records: TestRecord[] = [];
const logsDir = path.resolve(import.meta.dirname, "../logs");

/** 确保 logs 目录存在 */
function ensureLogsDir(): void {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

/**
 * 执行单个测试项
 * @param name 测试项名称
 * @param requirement 需求描述
 * @param fn 测试逻辑，抛出异常即为失败
 */
export async function test(
  name: string,
  requirement: string,
  fn: () => Promise<void>
): Promise<void> {
  let passed = true;
  let detail = "";

  try {
    await fn();
    detail = "通过";
  } catch (err: any) {
    passed = false;
    detail = err?.message ?? String(err);
  }

  const record: TestRecord = { name, requirement, passed, detail };
  records.push(record);

  // 实时终端输出
  const icon = passed ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✖\x1b[0m";
  console.log(`  ${icon} ${name}`);
  if (!passed) {
    console.log(`    \x1b[31m${detail}\x1b[0m`);
  }
}

/**
 * 输出测试汇总并保存日志文件
 * @param suiteName 测试套件名称（用作日志文件名前缀）
 */
export function summary(suiteName: string): void {
  const passed = records.filter((r) => r.passed).length;
  const failed = records.length - passed;

  console.log("");
  console.log("=".repeat(50));
  console.log(`  ${suiteName}  |  ${passed}/${records.length} 通过`);
  console.log("=".repeat(50));

  if (failed > 0) {
    console.log(`  \x1b[31m${failed} 项失败\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log("  \x1b[32m全部通过\x1b[0m");
  }

  // 生成日志内容
  const lines: string[] = [];
  for (const r of records) {
    lines.push(`测试项: ${r.name}`);
    lines.push(`需求: ${r.requirement}`);
    lines.push(`结果: ${r.passed ? "通过" : `失败 — ${r.detail}`}`);
    lines.push("");
  }

  // 写入日志文件
  try {
    ensureLogsDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${suiteName}-${ts}.log`;
    const filepath = path.join(logsDir, filename);
    fs.writeFileSync(filepath, lines.join("\n"), "utf-8");
    console.log(`  日志已保存: tests/logs/${filename}`);
  } catch (err) {
    console.error("  保存日志失败:", err);
  }
}

/**
 * Examples 一键启动器
 * - 自动扫描 examples 目录下的 .ts 示例
 * - 支持交互式选择单个示例或一键启动全部
 * - 自动为每个示例注入 CLIENT_ID 环境变量（格式：runner-<name>-01）
 *
 * 运行方式：
 *   npm run demo
 *   node --experimental-strip-types examples/runner.ts
 */

import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const files = readdirSync(__dirname)
  .filter((f) => f.endsWith(".ts") && f !== "runner.ts")
  .map((f) => f.replace(/\.ts$/, ""))
  .sort();

if (files.length === 0) {
  console.log("[Runner] 未找到任何示例文件");
  process.exit(0);
}

console.log("=================================");
console.log("  可用的示例列表：");
console.log("=================================");
files.forEach((name, i) => {
  console.log(`  [${String(i + 1).padStart(2)}] ${name}`);
});
console.log("  [ a] 启动全部");
console.log("  [ q] 退出");
console.log("=================================");

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question("\n请输入编号: ", (answer) => {
  const input = answer.trim().toLowerCase();

  if (input === "q") {
    console.log("[Runner] 已取消");
    rl.close();
    process.exit(0);
  }

  const toRun: string[] = [];
  if (input === "a") {
    toRun.push(...files);
  } else {
    const idx = parseInt(input, 10) - 1;
    if (idx >= 0 && idx < files.length) {
      toRun.push(files[idx]);
    } else {
      console.log("[Runner] 无效输入");
      rl.close();
      process.exit(1);
    }
  }

  rl.close();

  for (const name of toRun) {
    const clientId = `runner-${name}-01`;
    console.log(`[Runner] 启动 ${name} (CLIENT_ID=${clientId})`);

    const child = spawn("node", ["--experimental-strip-types", join("examples", `${name}.ts`)], {
      stdio: "inherit",
      env: { ...process.env, CLIENT_ID: clientId },
    });

    child.on("error", (err) => {
      console.error(`[Runner] ${name} 启动失败:`, err);
    });

    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[Runner] ${name} 退出码: ${code}`);
      }
    });
  }
});

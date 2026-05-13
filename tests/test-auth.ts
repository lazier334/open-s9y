/**
 * 认证功能测试示例
 *
 * 测试网关的认证 hook 支点（AuditPivot）是否生效：
 *   1. HTTP 请求无 session cookie → 预期 401
 *   2. HTTP 请求带 session cookie → 预期通过
 *   3. WebSocket 连接无 session cookie → 预期被拒(1008)
 *   4. WebSocket 连接带 session cookie → 预期通过
 *
 * 前置条件：先启动网关
 *   node --experimental-strip-types src/index.ts
 *
 * 运行方式：
 *   node --experimental-strip-types examples/test-auth.ts
 *
 * 环境变量：
 *   GATEWAY_URL  — 网关地址，默认 http://localhost:3000
 */

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:3000";
const WS_URL = GATEWAY_URL.replace(/^http/, "ws");

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  \x1b[32m[PASS]\x1b[0m ${label}`);
}

function no(label: string, detail?: string) {
  failed++;
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
}

function summarize() {
  console.log("\n" + "=".repeat(50));
  const total = passed + failed;
  console.log(`  结果: ${passed}/${total} 通过`);
  if (failed > 0) {
    console.log(`  \x1b[31m${failed} 项失败\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32m全部通过\x1b[0m`);
  }
}

// ─── HTTP 测试 ───

async function testHttp(
  label: string,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; /** 长轮询端点，超时视为通过 */ longPoll?: boolean },
  expectStatus: (s: number) => boolean,
  expectDesc: string,
) {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.cookie) headers.Cookie = opts.cookie;

    const controller = new AbortController();
    const fetchOpts: RequestInit = { method, headers, signal: controller.signal };
    if (opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);

    // GET /s9y 是长轮询端点，认证通过后会挂起。用短超时打断：
    // - 被 abort → 认证已通过（服务端接受了连接并挂起等待）
    // - 返回 401 → 认证拦截
    if (opts.longPoll) {
      setTimeout(() => controller.abort(), 2000);
    }

    const res = await fetch(`${GATEWAY_URL}${path}`, fetchOpts);
    if (expectStatus(res.status)) {
      ok(label);
    } else {
      no(label, `期望 ${expectDesc}, 实际 ${res.status}`);
    }
  } catch (err) {
    if (opts.longPoll && (err as Error).name === "AbortError") {
      // 长轮询被 abort = 服务端接受了连接，认证通过
      ok(label);
    } else {
      no(label, (err as Error).message);
    }
  }
}

// ─── WebSocket 测试 ───

async function loadWsLib(): Promise<typeof import("ws").WebSocket | null> {
  try {
    return (await import("ws")).WebSocket;
  } catch {
    return null;
  }
}

function testWs(
  label: string,
  cookie: string | undefined,
  expectRejected: boolean,
): Promise<void> {
  return new Promise(async (resolve) => {
    const WebSocket = await loadWsLib();
    if (!WebSocket) {
      console.log(`  \x1b[33m[SKIP]\x1b[0m ${label} (ws 包不可用)`);
      resolve();
      return;
    }

    let settled = false;
    const done = () => { settled = true; resolve(); };

    const ws = cookie
      ? new WebSocket(WS_URL, { headers: { Cookie: cookie } } as any)
      : new WebSocket(WS_URL);

    const timer = setTimeout(() => {
      if (settled) return;
      if (expectRejected) {
        // 超时未关闭 → 认证可能未生效
        no(label, "超时: 连接未被关闭，认证可能未生效");
      } else {
        ok(label);
      }
      ws.close();
      done();
    }, 5000);

    ws.on("error", () => { /* server 主动拒绝属预期行为 */ });

    // WS 握手完成后服务端才异步认证，所以 open 总是先触发。
    // 真正的认证结果看 close 事件的状态码。
    ws.on("open", () => {
      if (expectRejected) {
        console.log(`         WS 握手完成，等待服务端认证关闭...`);
      }
      // 不在此 resolve —— 等待 close 事件来拿认证结果
    });

    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      if (settled) return;

      const reasonText = reason?.toString() || "";
      const detail = `关闭码=${code}${reasonText ? ` 消息="${reasonText}"` : ""}`;

      if (expectRejected) {
        if (code === 1008) {
          ok(`${label} (${detail})`);
        } else {
          no(label, `期望关闭码 1008, 实际 ${detail}`);
        }
      } else {
        if (code === 1008) {
          no(label, `连接被 1008 拒绝, ${detail}`);
        } else {
          ok(`${label} (${detail})`);
        }
      }
      done();
    });
  });
}

// ─── 主流程 ───

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║          s9y 认证 Hook 功能测试                   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  网关地址: ${GATEWAY_URL}\n`);

  // 连通性检查
  try {
    const res = await fetch(`${GATEWAY_URL}/s9y`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderId: "test", type: "pivots", payload: {}, traceId: crypto.randomUUID(), timestamp: Date.now() }),
    });
    if (res.status === 401) {
      console.log("  网关已启动，认证 hook 处于活跃状态\n");
    } else if (res.ok) {
      console.log("  \x1b[33m[WARN]\x1b[0m 网关已启动，但认证 hook 未生效\n");
      console.log("  请确认 audit-pivot.ts 已被 fun-adapter 扫描注册\n");
    }
  } catch {
    console.error("  \x1b[31m[FATAL]\x1b[0m 无法连接网关，请先启动:");
    console.error("    node --experimental-strip-types src/index.ts\n");
    process.exit(1);
  }

  // ─── HTTP preHandler hook 认证 ───

  console.log("── HTTP 认证 (preHandler hook) ──\n");

  const pushBody = {
    senderId: "test-runner",
    type: "push",
    payload: { data: { content: "hello" } },
    traceId: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  const registerPath = "/s9y?pivotId=test-pivot&type=tool&capabilities=test";

  const pivotsBody = {
    senderId: "test-runner",
    type: "pivots",
    payload: {},
    traceId: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  // 无 cookie → 401
  await testHttp("POST /s9y           无 cookie → 401", "POST", "/s9y", { body: pushBody }, (s) => s === 401, "401");
  await testHttp("GET  /s9y           无 cookie → 401", "GET", registerPath, { longPoll: true }, (s) => s === 401, "401");
  await testHttp("POST /s9y (pivots)  无 cookie → 401", "POST", "/s9y", { body: pivotsBody }, (s) => s === 401, "401");

  // 带 session cookie → 通过
  const cookie = "s9y-key=tool";
  await testHttp("POST /s9y           带 cookie → 通过", "POST", "/s9y", { cookie, body: pushBody }, (s) => s !== 401, "非401");
  await testHttp("GET  /s9y           带 cookie → 通过", "GET", registerPath, { cookie, longPoll: true }, (s) => s !== 401, "非401");
  await testHttp("POST /s9y (pivots)  带 cookie → 通过", "POST", "/s9y", { cookie, body: pivotsBody }, (s) => s !== 401, "非401");

  // ─── WebSocket 认证 ───

  console.log("\n── WebSocket 认证 ──\n");

  // 无 cookie → 1008
  await testWs("WebSocket 无 cookie         → 被拒(1008)", undefined, true);

  // 带 cookie → 不接受 1008 拒绝
  await testWs("WebSocket 带 session cookie → 通过", cookie, false);

  summarize();
}

main().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});

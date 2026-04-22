/**
 * 多组织突发事件模拟测试
 * - 启动 3 个不同类型的 Organization（科技公司、政府部门、媒体机构）
 * - 每个 Organization 有独立的 leader + members
 * - Organization 之间通过 free_action 自动交流
 * - AutoDetector 自动检测系统上报突发事件
 * - 所有日志写入 examples/org/demo.log
 *
 * 运行方式：
 *   API_KEY=sk-xxx node --env-file=.env --experimental-strip-types examples/org/demo.ts
 *
 * ─── 协议原语 → 社会行为 映射 ───
 * | 社会行为        | 协议原语              | 说明                          |
 * |----------------|----------------------|------------------------------|
 * | 组织注册        | REGISTER             | 支点通过 gateway 注册接入       |
 * | 外部消息到达    | DELEGATE             | 网关将消息委托给组织处理          |
 * | 内部讨论        | SELF(internal_discuss)| 组织内部成员意见交换             |
 * | 自治行动        | SELF(free_action)    | 超时自触发，模拟组织自治决策       |
 * | 对外回应        | PIPE                 | 通过网关路由到目标支点           |
 * | 广播/禁言       | BROADCAST + 状态过滤  | 网关层面消息拦截与分发            |
 * | 查询在线节点    | QUERY                | 获取 peers 列表用于路由决策       |
 * | 动态加入        | REGISTER (运行时)     | 无需重启即可接入新组织            |
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Organization } from "./organization.ts";
import { Person } from "./person.ts";
import { AutoDetector } from "../broadcast-tool.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 日志配置 ───
// 支持通过环境变量指定日志路径，供循环测试时独立输出
const LOG_PATH = process.env.DEMO_LOG_PATH ?? path.join(__dirname, "demo.log");
const _log = console.log;
const _error = console.error;

console.log = function log(...args: any[]) {
  const line = args.join(" ");
  _log(line);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
};

console.error = function logError(...args: any[]) {
  const line = args.join(" ");
  _error(line);
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] [ERROR] ${line}\n`);
};

fs.writeFileSync(LOG_PATH, `=== 多组织突发事件模拟日志 ${new Date().toISOString()} ===\n\n`);

// ─── 配置 ───
const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:3000";
const apiKey = process.env.API_KEY ?? "";
/** 总运行时间上限（毫秒），默认 3 分钟 */
const TOTAL_RUN_TIME = parseInt(process.env.TOTAL_RUN_TIME ?? "180000", 10);

if (!apiKey) {
  console.error("[Demo] 错误: 请设置 API_KEY 环境变量");
  process.exit(1);
}

/** 创建带 API key 的 Person（temperature=0 保证确定性） */
function createPerson(name: string, role: string): Person {
  return new Person({ name, role, apiKey, temperature: 0 });
}

// ─── 组织定义 ───

const orgConfigs = [
  {
    pivotId: "tech-corp",
    name: "星辰科技",
    capabilities: { domain: "tech", canSupport: true },
    systemPrompt: `你是星辰科技的对外发言人，一家高科技企业的代表。
你们的核心关切是：技术资产安全、业务连续性保障、市场信心维护、合规风险防控。
收到外部消息后，内部讨论应围绕技术评估、财务影响、商业机会展开。
对外回复需体现科技行业的专业性与前瞻性，避免使用政府公文或新闻报道的语气。`,
    leader: createPerson("张明", "CEO，科技行业领军人物，善于从商业角度分析局势"),
    members: [
      createPerson("李华", "CTO，技术极客，关注技术实现和安全风险"),
      createPerson("王芳", "CFO，财务严谨，关注成本和市场影响"),
    ],
  },
  {
    pivotId: "gov-emergency",
    name: "市应急管理局",
    capabilities: { domain: "emergency", canRelay: true },
    canRelay: true,
    systemPrompt: `你是市应急管理局的对外发言人，政府应急管理部门的代表。
你们的核心关切是：公众生命安全、应急响应效率、社会秩序稳定、灾情信息透明。
收到外部消息后，内部讨论应围绕应急预案启动、资源调配、人员疏散、舆情管控展开。
对外回复需体现政府的权威性、责任感和行动力，措辞严谨、指令清晰。`,
    leader: createPerson("刘建国", "局长，统筹全局，经验丰富"),
    members: [
      createPerson("赵敏", "灾害预警专家，冷静理性"),
      createPerson("孙伟", "舆情监控专员，关注公众反应"),
    ],
  },
  {
    pivotId: "city-news",
    name: "都市报编辑部",
    capabilities: { domain: "media", canReport: true },
    systemPrompt: `你是都市报编辑部的对外发言人，一家地方主流媒体的代表。
你们的核心关切是：新闻真实性、报道时效性、舆论引导责任、公众知情权。
收到外部消息后，内部讨论应围绕事实核实、报道角度、信息来源可靠性、社会影响展开。
对外回复需体现媒体的专业独立性，既追求真相也关注社会责任。`,
    leader: createPerson("陈主编", "新闻主编，嗅觉敏锐"),
    members: [
      createPerson("小李", "突发新闻记者，行动迅速"),
      createPerson("老周", "深度调查记者，善于挖掘真相"),
    ],
  },
];

// ─── 主流程 ───

async function main() {
  console.log("=================================");
  console.log("  多组织突发事件模拟测试");
  console.log("=================================");
  console.log(`网关: ${gatewayUrl}`);
  console.log(`组织数: ${orgConfigs.length}`);
  console.log(`日志文件: ${LOG_PATH}`);
  console.log("=================================\n");

  // 协议统计计数器
  const stats = {
    register: 0,
    broadcast: 0,
    pipe: 0,
    delegate: 0,
    consensus: 0,
    query: 0,
    self: 0,
    totalMessages: 0,
    peakOrgs: orgConfigs.length,
  };

  /** 拦截日志并统计协议原语 */
  function trackProtocol(...args: any[]) {
    const line = args.join(" ");
    stats.totalMessages++;
    const match = line.match(/\[Protocol\]\s+\S+\s+→\s+(\w+)/);
    if (match) {
      const primitive = match[1].toLowerCase();
      if (primitive in stats) {
        (stats as any)[primitive]++;
      }
    }
    console.log(...args);
  }

  // 启动所有组织
  const orgs: Organization[] = [];
  for (const cfg of orgConfigs) {
    const org = new Organization({
      gatewayUrl,
      pivotId: cfg.pivotId,
      name: cfg.name,
      leader: cfg.leader,
      members: cfg.members,
      systemPrompt: cfg.systemPrompt,
      capabilities: cfg.capabilities,
      canRelay: cfg.canRelay,
      apiKey,
      onLog: trackProtocol,
      onError: (...args: any[]) => console.error(...args),
    });
    await org.connect();
    orgs.push(org);
    console.log(`[Demo] ✅ ${cfg.name} (${cfg.pivotId}) 已连接`);
  }

  // 启动自动检测系统
  const detector = new AutoDetector({
    gatewayUrl,
    pivotId: "auto-detector",
    apiKey,
    onLog: trackProtocol,
    onError: (...args: any[]) => console.error(...args),
  });
  await detector.connect();
  console.log(`[Demo] ✅ 自动检测系统已连接\n`);

  // 等待组织完成注册
  await delay(5000);
  console.log("[Demo] 所有节点就绪，开始模拟...\n");

  // 设置总运行时间上限（兜底退出）
  const timeoutTimer = setTimeout(() => {
    console.log(`[Demo] ⏰ 达到总运行时间上限 ${TOTAL_RUN_TIME / 1000} 秒，自动终止`);
    shutdown(orgs, detector, stats);
  }, TOTAL_RUN_TIME);

  // ─── 事件剧本 ───
  // 信息分层演示：
  // - 地震（严重）→ 直接广播给所有组织
  // - 新型流感（初期不明朗）→ 只发给 domain=emergency 的应急管理局
  //   应急管理局内部评估后，若判断严重，再主动转发给其他组织
  const baseDate = new Date();
  const fmtDate = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

  const events = [
    { delayMs: 3000, dayOffset: 0, narrative: "平静被打破...", fn: () => detector.disaster("市郊发生 5.2 级地震，震源深度 10km，已启动三级应急响应") },
    { delayMs: 40000, dayOffset: 1, narrative: "一夜过去，清晨...", fn: () => detector.broadcastTo("virus", { description: "市内出现不明原因呼吸道传染病，建议减少聚集" }, "domain", "emergency") },
    { delayMs: 30000, dayOffset: 2, narrative: "局势进一步升级...", fn: () => detector.mute(20000) },
    { delayMs: 30000, dayOffset: 3, narrative: "管控措施逐步解除...", fn: () => detector.unmute() },
    { delayMs: 30000, dayOffset: 4, narrative: "事态继续发展...", fn: () => detector.arrest("某科技高管", "涉嫌泄露敏感数据") },
    {
      delayMs: 15000,
      dayOffset: 5,
      narrative: "救援力量得到补充...",
      fn: async () => {
        // 动态加入新组织：红十字会（无需重启，运行时 REGISTER）
        console.log("[Demo] 🆕 动态加入新组织：红十字会\n");
        const redCross = new Organization({
          gatewayUrl,
          pivotId: "red-cross",
          name: "市红十字会",
          systemPrompt: `你是市红十字会的对外发言人，一家非营利人道救援组织的代表。\n你们的核心关切是：伤员救助、物资调配、志愿者动员、心理援助。\n收到外部消息后，内部讨论应围绕救援方案、物资需求、人员协调展开。\n对外回复需体现人道主义精神、行动力和关怀。`,
          leader: createPerson("周主任", "红十字会主任，经验丰富，善于协调资源"),
          members: [
            createPerson("小杨", "急救护士，反应迅速，关注伤员救治"),
            createPerson("老马", "物资调配员，擅长物流和供应链管理"),
          ],
          apiKey,
          onLog: trackProtocol,
          onError: (...args: any[]) => console.error(...args),
        });
        await redCross.connect();
        orgs.push(redCross);
        if (orgs.length > stats.peakOrgs) stats.peakOrgs = orgs.length;
        console.log(`[Demo] ✅ 红十字会已动态接入，现有 ${orgs.length} 个组织\n`);
        return 1;
      },
    },
  ];

  let elapsed = 0;
  for (const evt of events) {
    const wait = evt.delayMs;
    const targetDate = new Date(baseDate);
    targetDate.setDate(baseDate.getDate() + evt.dayOffset);
    console.log(`[Demo] ⏳ ${evt.narrative}（${wait / 1000} 秒后进入 ${fmtDate(targetDate)}）\n`);
    await delay(wait);
    elapsed += wait;
    const count = await evt.fn();
    if (typeof count === "number") {
      console.log(`[Demo] 📢 广播已发送给 ${count} 个目标\n`);
    }
  }

  // 最后等待一段时间让组织自由交流
  const finalDate = new Date(baseDate);
  finalDate.setDate(baseDate.getDate() + 6);
  console.log(`[Demo] ⏳ 进入观察期...（${fmtDate(finalDate)}）\n`);
  await delay(30000);

  clearTimeout(timeoutTimer);
  console.log("[Demo] ✅ 模拟结束");
  shutdown(orgs, detector, stats);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ProtocolStats {
  register: number;
  broadcast: number;
  pipe: number;
  delegate: number;
  consensus: number;
  query: number;
  self: number;
  totalMessages: number;
  peakOrgs: number;
}

function shutdown(
  orgs: Organization[],
  detector: AutoDetector,
  stats: ProtocolStats
): void {
  console.log("\n[Protocol] gateway → SUMMARY");
  console.log(`  - 总消息数: ${stats.totalMessages}`);
  console.log(
    `  - 协议原语分布: REGISTER(${stats.register}), BROADCAST(${stats.broadcast}), PIPE(${stats.pipe}), DELEGATE(${stats.delegate}), CONSENSUS(${stats.consensus}), QUERY(${stats.query}), SELF(${stats.self})`
  );
  console.log(`  - 活跃连接峰值: ${stats.peakOrgs} 个组织`);
  console.log(
    "[Demo] ✅ s9y 协议通过最小原语集支撑了复杂应急响应协调"
  );

  console.log("[Demo] 正在关闭所有节点...");
  for (const org of orgs) org.disconnect();
  detector.disconnect();
  console.log("[Demo] 所有节点已断开");
  process.exit(0);
}

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n[Demo] 收到中断信号");
  process.exit(0);
});

main().catch((err) => {
  console.error("[Demo] 启动失败:", err);
  process.exit(1);
});

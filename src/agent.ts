/**
 * Node.js 全自动自愈 Agent | 无人值守版 | OpenAI通用接口
 * 支持: OpenAI兼容模式
 * 启动命令: node --env-file=.env src/agent.ts
 */
import { spawn } from 'node:child_process';
import type { SpawnOptions, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Stream } from "node:stream";

// ==================== 配置 ====================
// #region 配置
const CONFIG = {
    /** ai的key */
    API_KEY: process.env.OPENAI_API_KEY || '',
    /** ai的基础url */
    BASE_URL: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    /** ai的模型名称 */
    MODEL: process.env.MODEL || 'deepseek-chat',
    /** ai最大思考次数 */
    MAX_TURNS: Number(process.env.MAX_TURNS) || 10,
    /** shell执行器 */
    SHELL: os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash',
    /** shell执行器的标识 */
    SHELL_FLAG: os.platform() === 'win32' ? '/c' : '-c',
    /** 命令执行超时60秒 */
    TIMEOUT: 60000,
    /** 输入文件路径 */
    FILE_POLLER: process.env.FILE_POLLER == 'true',
    /** 输入文件路径 */
    INPUT_FILE: process.env.AGENT_INPUT || './agent-input.txt',
    /** 轮询间隔(ms) */
    POLL_INTERVAL: 2000,
    /** agent的id, 用于打印日志 */
    agentId: 0,
    /** 网关启动命令 */
    GATEWAY_CMD: process.env.GATEWAY_CMD || 'node --env-file=.env src/gateway.ts',
    /** 网关重启策略: never/on-failure/always */
    GATEWAY_RESTART_POLICY: process.env.GATEWAY_RESTART_POLICY || 'on-failure',
    /** 网关日志路径（与系统错误日志分开） */
    GATEWAY_LOGS_PATH: process.env.GATEWAY_LOGS_PATH || './logs/gateway-crash.log',
};
// #endregion 配置

// ==================== 颜色 ====================
// #region 颜色
const COLORS = [
    '\x1b[32m', // 1: 绿色 (Green)
    '\x1b[35m', // 2: 洋红 (Magenta)
    '\x1b[34m', // 3: 蓝色 (Blue)
    '\x1b[33m', // 4: 黄色 (Yellow)  
    '\x1b[31m', // 5: 红色 (Red)
    '\x1b[36m', // 6: 青色 (Cyan)
    '\x1b[90m', // 7: 亮黑 (Gray)
];
const COLORS_RESET = '\x1b[0m';
function getColor(id: number): string {
    return COLORS[id % COLORS.length] || COLORS[COLORS.length - 1];
}
// #endregion 颜色

// ==================== 安全策略（硬限制） ====================
// #region 安全策略（硬限制）
const SECURITY = {
    // 允许的基础命令（完全自动模式下必须严格）
    ALLOWED_COMMANDS: [
        'npm', 'yarn', 'pnpm', 'npx', 'node', 'tsc',
        'rm', 'del', 'rmdir', 'mkdir', 'touch', 'cp', 'mv', 'xcopy', 'copy',
        'git', 'cat', 'ls', 'dir', 'echo', 'cd', 'pwd', 'clear', 'cls'
    ],

    // 危险模式黑名单（正则）
    DANGEROUS_PATTERNS: [
        /rm\s+-rf\s*\/[ ]*$/,           // rm -rf / 或 rm -rf /*
        /mkfs\.?/,                      // 格式化
        /dd\s+if=/,                     // 磁盘操作
        />[ ]*\/etc\//,                 // 覆盖系统文件
        /curl.+pipe.+sh/,               // curl | sh 管道执行
        /wget.+http.*\.(sh|bat|exe)/,   // 下载可执行文件
        /\.\.[\/\\]/,                   // 上级目录遍历
        /%SYSTEMROOT%|C:\\Windows/i,    // Windows系统目录
        /sudo\s+rm/,                    // 特权删除
        /:(){ :|:& };:/                 // Fork炸弹
    ],

    // 允许的操作目录（必须在此范围内）
    ALLOWED_ROOT: process.cwd()
};
// #endregion 安全策略（硬限制）
// #region 启动主程序
main();
// #endregion 启动主程序

// ==================== 主程序 ====================
// #region 主程序
/** 主程序 */
async function main() {
    // 启动自修复程序
    autoRepairFile();
    // 同步等待测试AI连接
    await testChat();
    // 启动自我异常维护程序
    selfHealing();
    // 根据配置决定是否启动文件轮询
    if (CONFIG.FILE_POLLER) FilePoller.getInstance(new AutoHealingAgent(), CONFIG.INPUT_FILE);
    else setInterval(() => { }, 24 * 60 * 60 * 1000);
    // 启动网关
    gatewayStarter();
}
// #endregion 主程序

// ==================== 自修复工具 ====================
// #region 自修复工具
/**
 * 当前程序脚本自修复工具  
 * 用于当前文件被误删的情况下，在程序退出前自动恢复文件
 */
function autoRepairFile() {
    const __filename = fileURLToPath(import.meta.url);
    const SELF_CODE = fs.readFileSync(__filename, 'utf8');
    // 文件不存在就用缓存的代码写回去
    const repair = () => {
        if (!fs.existsSync(__filename)) {
            fs.writeFileSync(__filename, SELF_CODE, 'utf8');
            console.log('文件已恢复！', __filename);
        }
    };

    // 监听所有退出场景
    process.on('exit', repair);
    process.on('SIGINT', () => process.exit());
    process.on('SIGTERM', () => process.exit());
    // 这里设置程序异常时不会退出程序
    process.on('uncaughtException', repair);
    process.on('unhandledRejection', repair);

    console.log('单文件程序自修复运行中! 程序异常或关闭时会自动恢复当前文件', __filename);
}
// #endregion 自修复工具

// ==================== 网关守护启动器 ====================
// #region 网关守护启动器
/**
 * 给cmd使用的数据存储对象，用来给外部提供更多控制能力
 */
interface cmdData {
    /** 日志列表 */
    logs: any[];
    /** 预定义的属性，需要手动实现添加数据功能 */
    output: string;
    /** 允许任意其他属性 */
    [key: string]: any;
}
/**
 * 运行cmd  
 * 默认用于启动网关
 * @param cmd 命令
 * @param stdout 正常运行的输出
 * @param stderr 错误信息输出
 * @returns 运行结束返回最后的50-100条日志
 * @example
 * // 空参数
 * runCmd().catch(err => console.log('err=>', err))
 * // 完整参数
 * runCmd('node --env-file=.env src/gateway.ts', (d) => console.log('--->', '' + d), (d) => console.log('===>', '' + d)).catch(err => console.log('err=>', err))
 */
function gatewayRunCmd(cmd: string | Array<any> = 'node --env-file=.env src/gateway.ts', stdout: (stream: Stream.Readable, data: cmdData) => void = () => { }, stderr: (stream: Stream.Readable, data: cmdData) => void = () => { }): Promise<cmdData> {
    return new Promise((resolve, reject) => {
        let child: ChildProcess | null = null;
        let data: cmdData = {
            logs: [],
            output: ''
        }
        showLog('启动进程...');
        if (typeof cmd == 'string') cmd = cmd.split(' ').filter(e => e.trim() != '');
        child = spawn(cmd[0], cmd.slice(1, cmd.length), {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        child.stdout?.on('data', stream => {
            let log = `[OUT] ${stream}`;
            addLogs(log);
            process.stdout.write(log)
            stdout(stream, data);
        });
        child.stderr?.on('data', stream => {
            let log = `[ERR] ${stream}`;
            addLogs(log);
            process.stderr.write(log);
            stderr(stream, data);
        });

        // 确保日志目录存在
        const logDir = path.dirname(CONFIG.GATEWAY_LOGS_PATH);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        if (fs.existsSync(CONFIG.GATEWAY_LOGS_PATH) && fs.statSync(CONFIG.GATEWAY_LOGS_PATH).isFile()) fs.rmSync(CONFIG.GATEWAY_LOGS_PATH);
        // 进程退出
        child.on('close', code => {
            addLogs('ExitCode:' + code);
            showLog(`进程退出 code: ${code}`);
            if (code == 0) {
                resolve(data);
            } else {
                fs.writeFileSync(CONFIG.GATEWAY_LOGS_PATH, JSON.stringify(data.logs, null, 2));
                reject(data);
            }
        });

        // 显示日志
        function showLog(...args: any[]) {
            console.log('[Agent]', ...args)
        }
        // 添加日志信息，同时只保留最后的50条数据
        function addLogs(log: any) {
            data.logs.push(log);
            if (100 < data.logs.length) {
                data.logs.splice(data.logs.length - 50)
            }
        }
    })
}

/** 网关启动配置选项 */
interface GatewayOptions {
    /** 启动命令，默认 'node --env-file=.env src/gateway.ts' */
    command?: string | string[];
    /** 重启策略: 'never' | 'on-failure' | 'always' | number(次数) */
    restartPolicy?: 'never' | 'on-failure' | 'always' | number;
    /** 防重启风暴间隔(ms)，默认 5000 */
    minRestartInterval?: number;
}

/**
 * 创建网关启动器的 AI Tool 定义
 * 注册到 chatCompletion 的 tools 参数中，让 AI 知道可以调用此功能启动网关
 */
function createGatewayStarterTool(): any {
    return {
        type: 'function',
        function: {
            name: 'start_gateway_guardian',
            description: `启动 Node.js 网关进程并进入守护模式。当网关崩溃时，会自动分析日志并尝试修复。
适用场景：
- 首次启动网关
- 网关因代码错误/依赖缺失/端口占用(EADDRINUSE)崩溃后重启
- 需要持续监控网关健康状态

修复策略优先级：
1. 模块缺失 → npm install / yarn add
2. 端口占用 → 执行 lsof -i :PORT -t | xargs kill -9 或修改配置  
3. TS编译错误 → tsc --noEmit 检查类型
4. 内存溢出 → 增加 --max-old-space-size=4096

注意：修复成功后系统会自动重启网关`,
            parameters: {
                type: 'object',
                properties: {
                    command: {
                        type: 'string',
                        description: '启动命令，如 "node --env-file=.env src/gateway.ts"',
                        default: 'node --env-file=.env src/gateway.ts'
                    },
                    restart_policy: {
                        type: 'string',
                        enum: ['never', 'on-failure', 'always'],
                        description: '崩溃后是否重启',
                        default: 'on-failure'
                    }
                },
                required: []
            }
        }
    };
}

/**
 * 启动网关并进入守护模式（崩溃后自动修复并重试）
 * @param agent - AutoHealingAgent 实例（可选，默认创建专用网关Agent）
 * @param options - 启动配置
 * @returns Promise<cmdData> 正常退出时 resolve，彻底失败时 reject
 */
async function gatewayStarter(
    agent?: AutoHealingAgent, options: GatewayOptions = {}): Promise<cmdData> {
    const {
        command = 'node --env-file=.env src/gateway.ts',
        restartPolicy = 'on-failure',
        minRestartInterval = 5000
    } = options;

    // 初始化专用 Agent（带网关专用提示词）
    if (!agent) {
        agent = new AutoHealingAgent([{
            role: 'system',
            content: `你是网关守护 Agent,专门处理 Node.js 网关进程的启动与崩溃修复。

当前环境:
- 操作系统: ${os.platform()}
- 工作目录: ${SECURITY.ALLOWED_ROOT}
- 允许命令: ${SECURITY.ALLOWED_COMMANDS.join(', ')}

错误诊断指南:
1. Cannot find module → npm install xxx
2. EADDRINUSE(端口占用) → lsof -i :PORT -t | xargs kill -9
3. TypeScript错误 → tsc --noEmit 后修复类型
4. 内存溢出 → node --max-old-space-size=4096


输出格式必须是纯JSON(不要markdown):
{"action":"execute_command","command":"...","reason":"...","retry_after":true}`
        }], [createGatewayStarterTool()]);
    }

    let restartCount = 0;
    let lastRestartTime = 0;

    /**
     * 内部递归启动函数
     */
    const startOnce = async (): Promise<cmdData> => {
        restartCount++;
        agent.log(`🚀 启动网关 (第${restartCount}次): ${Array.isArray(command) ? command.join(' ') : command}`);

        try {
            // 使用现有的 gatewayRunCmd，传入空回调（让它自己处理输出）
            const result = await gatewayRunCmd(command, () => { }, () => { });

            // 正常退出（code 0）
            if (restartPolicy === 'always') {
                agent.log('✅ 网关正常退出，根据策略准备重启...');
                await delay(minRestartInterval);
                return startOnce(); // 递归重启
            }
            return result;

        } catch (errorData: any) {
            // 异常退出，触发修复流程
            agent.log(`⚠️ 网关崩溃 (exit: ${errorData?.logs?.find((l: string) => l.includes('ExitCode:'))?.split(':')[1] || 'unknown'})`);

            // 构造错误上下文（取最后50条日志）
            const recentLogs = (errorData?.logs || []).slice(-50).join('\n');
            const errorMsg = `网关异常退出，最近日志:\n${recentLogs.slice(-10000)}`;

            // 清空上下文，准备修复
            agent.clean();

            // 尝试修复
            const fixed = await agent.fixError(new Error('Gateway crashed'), errorMsg);

            if (!fixed) {
                agent.error('💥 网关修复失败，放弃重启');
                throw errorData; // 向上抛出，结束守护
            }

            // 检查重启策略
            const shouldRestart = restartPolicy === 'always' ||
                (restartPolicy === 'on-failure') ||
                (typeof restartPolicy === 'number' && restartCount < restartPolicy);

            if (!shouldRestart) {
                agent.log('🛑 根据策略不再重启');
                throw errorData;
            }

            // 防重启风暴
            const sinceLast = Date.now() - lastRestartTime;
            if (sinceLast < minRestartInterval) {
                const wait = minRestartInterval - sinceLast;
                agent.log(`⏳ 防重启风暴，等待 ${wait}ms...`);
                await delay(wait);
            }

            lastRestartTime = Date.now();
            agent.log('🔄 修复完成，准备重启...');

            // 递归重启
            return startOnce();
        }
    };

    return startOnce();
}

/** 延迟辅助函数 */
function delay(ms: number) {
    return new Promise(r => setTimeout(r, ms))
}
// #endregion 网关守护启动器

// ==================== 跨平台执行器 ====================
// #region 跨平台执行器
async function executeCommand(rawCommand: string): Promise<{ success: boolean, output: string }> {
    // 1. 安全校验
    const validation = validateCommand(rawCommand);
    if (!validation.safe) {
        return { success: false, output: `🚫 安全拦截: ${validation.reason}` };
    }

    const command = validation.sanitized;
    console.log(`⚡ 执行命令: ${command}`);

    return new Promise((resolve, reject) => {
        if (!command) {
            return resolve({ success: false, output: '🚫 命令处理后为空' });
        }
        const child = spawn(CONFIG.SHELL, [CONFIG.SHELL_FLAG, command], {
            cwd: SECURITY.ALLOWED_ROOT,
            env: process.env,
            timeout: CONFIG.TIMEOUT,
            stdio: ['pipe', 'pipe', 'pipe']
        } as SpawnOptions);

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            process.stdout.write(chunk); // 实时输出
        });

        child.stderr?.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            process.stderr.write(chunk); // 实时输出
        });

        child.on('close', (code) => {
            resolve({
                success: code === 0,
                output: stdout + (stderr ? `\n[stderr]:${stderr}` : '')
            });
        });

        child.on('error', (err) => {
            resolve({ success: false, output: `进程错误: ${err.message}` });
        });
    });
}
// #endregion 跨平台执行器

// ==================== 安全校验逻辑 ====================
// #region 安全校验逻辑
function validateCommand(cmd: string): { safe: boolean, reason?: string, sanitized?: string } {
    // 检查危险模式
    for (const pattern of SECURITY.DANGEROUS_PATTERNS) {
        if (pattern.test(cmd)) {
            return { safe: false, reason: `匹配危险模式: ${pattern.source}` };
        }
    }

    // 解析命令主体（简单分词）
    const parts = cmd.split(/[|&;]+/).map(p => p.trim()).filter(Boolean);

    for (const part of parts) {
        const firstWord = part.trim().split(/\s+/)[0].toLowerCase();

        // 检查是否在白名单
        if (!SECURITY.ALLOWED_COMMANDS.some(c => firstWord === c || firstWord.endsWith('/' + c))) {
            return { safe: false, reason: `命令"${firstWord}"不在白名单` };
        }
    }

    // 路径规范化检查（防止 ../../）
    if (cmd.includes('..')) {
        // 只允许删除 node_modules 或 .cache 等安全目录中的..
        if (!/node_modules[\\/]\.cache[\\/]\.\./.test(cmd)) {
            return { safe: false, reason: '包含上级目录遍历(..)' };
        }
    }

    return { safe: true, sanitized: cmd };
}
// #endregion 安全校验逻辑

// ==================== 通用 OpenAI 接口客户端 ====================
// #region 通用 OpenAI 接口客户端
/** 消息对象 */
interface Message {
    /** 
     * 消息角色
     * - system: 系统提示，设定AI身份和行为规则（如"你是Node.js专家"）
     * - user: 用户输入，人类的提问或指令
     * - assistant: AI助手的回复，用于保存历史上下文
     */
    role: 'system' | 'user' | 'assistant';
    content: string;
}
type ChatResult = {
    content: string | null;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
};
/** 可打断的聊天任务 */
interface ChatTask {
    /** 立即打断请求 */
    abort: () => void;
    /** 原始 Response 对象（用于流式读取或检查状态） */
    response: Promise<Response>;
    /** 解析后的 JSON 数据（await 这个获取 AI 回复） */
    data: Promise<ChatResult>;
}

/**
 * 发起可打断的对话请求
 * @returns ChatTask 包含打断方法和数据 Promise
 */
function chatCompletion(messages: Message[], tools?: any[]): ChatTask {
    const controller = new AbortController();
    const signal = controller.signal;

    const url = `${CONFIG.BASE_URL}/chat/completions`;
    const body: any = {
        model: CONFIG.MODEL,
        messages,
        temperature: 0.1,
        max_tokens: 2000
    };

    if (tools && CONFIG.MODEL.includes('gpt')) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }

    // 发起 fetch，但不 await
    const responsePromise = fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${CONFIG.API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
    });

    // 包装 data Promise：自动处理 HTTP 错误和 JSON 解析
    const dataPromise = responsePromise.then(async (res) => {
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`API ${res.status}: ${text}`);
        }
        const data = await res.json();
        return {
            content: data.choices[0].message.content,
            tool_calls: data.choices[0].message.tool_calls
        };
    });

    return {
        /** 调用此函数立即中断请求 */
        abort: () => controller.abort(),
        /** 原始 Response Promise（如果需要读取 headers 或流） */
        response: responsePromise,
        /** 解析后的业务数据 Promise（await 这个获取结果） */
        data: dataPromise
    };
}
/** 测试是否能用 */
async function testChat() {
    try {
        if (!CONFIG.API_KEY) throw new Error('API_KEY 不能为空');
        if (!CONFIG.BASE_URL) throw new Error('BASE_URL 不能为空');
        if (!CONFIG.MODEL) throw new Error('MODEL 不能为空');
        const chat = chatCompletion([{ role: 'user', content: '你好' }]);
        const data = await chat.data;
        if (data.content) {
            console.log('AI连接测试:', data)
        } else throw new Error('消息为空!');
    } catch (err) {
        console.error(err);
        throw new Error('AI连接测试失败!');
    }
}
// #endregion 通用 OpenAI 接口客户端

// ==================== Agent 核心 ====================
// #region Agent 核心
class AutoHealingAgent {
    private messages: Message[] = [];
    // 防止并发冲突
    private isProcessing = false;
    private id = 0;
    private tools: any[] = [];

    /** 打印日志 */
    log(...args: any[]) {
        console.log(`${getColor(this.id)}[${this.id}]`, ...args, COLORS_RESET);
    }
    error(...args: any[]) {
        console.log(`${getColor(this.id)}[${this.id}]`, ...args, COLORS_RESET);
    }

    constructor(messages: Message[] = [], tools?: any[]) {
        this.id = CONFIG.agentId++;
        this.messages = messages;
        if (tools) this.tools = tools;
    }

    /**
     * 修复错误
     * @param msg 消息内容或者Error对象
     * @param context 当是Error对象的时候可以附加上下文说明
     * @returns 返回true即修复成功
     */
    async fixError(msg: string | Error, context?: string): Promise<boolean> {
        if (this.isProcessing) {
            this.log('⏳ 正在处理其他任务，跳过');
            return false;
        }
        this.isProcessing = true;
        if (typeof msg != 'string') {
            msg = `
异常: ${msg.name}
消息: ${msg.message}
堆栈: ${msg.stack?.split('\n').slice(0, 3).join('\n')}
上下文: ${context || '应用运行时'}
当前目录文件: ${fs.readdirSync('.').slice(0, 10).join(', ')}...`.trim();
        }

        this.messages.push({ role: 'user', content: msg });
        for (let i = 0; i < CONFIG.MAX_TURNS; i++) {
            try {
                this.log(`🤖 ${CONFIG.MODEL}尝试修复中... (${i + 1}/${CONFIG.MAX_TURNS})`);
                const content = await this.input('请继续');

                // 解析JSON动作
                const action = this.parseAction(content);
                // 执行动作
                let result: string;
                if (!action) {
                    result = '无法识别的action,请再次尝试';
                    this.log('⚠️ 无法识别的action');
                } else if (action.action === 'read_file') {
                    result = await this.readFile(action.path);
                } else if (action.action === 'execute_command') {
                    const exec = await executeCommand(action.command);
                    result = exec.output;
                    if (exec.success) {
                        this.log('✅ 修复成功');
                        this.isProcessing = false;
                        return true;
                    }
                } else {
                    result = '未知动作';
                }

                // 反馈给AI
                this.messages.push({ role: 'user', content: `执行结果: ${result.substring(0, 500)}` });
            } catch (err) {
                this.error('修复时异常', err)
            }
        }
        this.isProcessing = false;
        return false;
    }

    private parseAction(content: string): any {
        try {
            // 提取JSON（支持被markdown包裹的情况）
            const clean = content.replace(/```json\s*|\s*```/g, '').trim();
            const json = clean.match(/\{[\s\S]*\}/)?.[0];
            if (!json) return null;
            return JSON.parse(json);
        } catch {
            return null;
        }
    }

    private async readFile(filePath: string): Promise<string> {
        try {
            // 安全检查：只允许读取当前目录下文件
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(SECURITY.ALLOWED_ROOT)) {
                return '错误: 路径超出项目范围';
            }
            return fs.readFileSync(resolved, 'utf-8');
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return `读取失败: ${message}`;
        }
    }
    /** 打断当前正在进行的对话 */
    stop() { }
    /** 清理消息，只保留第一条消息 */
    clean() {
        this.messages.splice(1)
    }
    /**
     * 输入文字消息，会打断上一条消息，如果上一条消息还没有处理完成则会被清理
     * @param txt 输入的消息
     * @returns 
     */
    async input(txt: string) {
        try { this.stop(); } catch (err) { }
        this.log('🧑:', txt);
        this.messages.push({ role: 'user', content: txt });
        const chatTask = chatCompletion(this.messages, this.tools.length > 0 ? this.tools : undefined);
        this.log('请求中,请稍等...');
        this.stop = typeof chatTask.abort == 'function' ? chatTask.abort : () => { };
        return chatTask.data.then(json => {
            const re = json.content ?? '';
            this.log('🤖:', re);
            this.messages.push({
                role: 'assistant',
                content: re
            });
            // 处理 AI 请求调用工具的情况
            if (json.tool_calls && json.tool_calls.length > 0) {
                for (const call of json.tool_calls) {
                    if (call.function.name === 'start_gateway_guardian') {
                        const args = JSON.parse(call.function.arguments);
                        // 启动网关
                        gatewayStarter(this, {
                            command: args.command,
                            restartPolicy: args.restart_policy
                        });
                        return `已启动网关守护，命令: ${args.command || CONFIG.GATEWAY_CMD}`;
                    }
                }
            }
            return re
        }).catch(err => {
            this.error('消息处理异常', err);
            return '';
        });
    }
}
// #endregion Agent 核心

// ==================== 全局异常拦截器 ====================
// #region 全局异常拦截器
export function selfHealing() {
    const agent = new AutoHealingAgent([{
        role: 'system', content: `你是Node.js环境自动修复Agent, 运行在${os.platform()}
当前工作目录: ${SECURITY.ALLOWED_ROOT}
平台Shell: ${CONFIG.SHELL}

可用修复工具:
1. read_file: 读取文件分析错误
2. execute_command: 执行修复命令(受白名单限制：${SECURITY.ALLOWED_COMMANDS.join(', ')})

特殊工具:
- 如需启动/重启网关，可调用工具: start_gateway_guardian
  参数: {command?: string, restart_policy?: "never"|"on-failure"|"always"}

自动修复策略(按优先级):
- 模块缺失 → npm install / yarn add
- 权限错误 → 检查package.json或目录权限
- 缓存问题 → rm -rf node_modules && npm install  
- 类型错误 → tsc --noEmit 检查

输出格式必须是纯JSON(不要markdown):
{"action":"execute_command","command":"npm install","reason":"修复缺失依赖xxx"}` }]);
    const errorCache: Error[] = [];
    const MAX_CACHE_SIZE = 10;
    /**
     * 使用agent处理异常
     * @param error 异常对象
     * @param msg 异常类型消息
     * @returns 
     */
    async function handleError(error: Error, msg: string) {
        if (errorCache.length >= MAX_CACHE_SIZE) {
            errorCache.shift();
        }
        errorCache.push(error);
        // 对于某些可恢复的错误尝试修复
        const fixed = await agent.fixError(error, msg);
        if (fixed) {
            agent.log('🔄 修复完成，继续运行');
            errorCache.splice(0);
            return true;
        }
        agent.log('❌ 修复失败，检查是否为重复错误...');
        // TODO 如果同样类型的异常连续重复出现3次就退出
        const ERROR_MAX = 3;
        if (errorCache.length >= ERROR_MAX) {
            const lastThree = errorCache.slice(-ERROR_MAX);
            const firstMsg = lastThree[0].message;
            const allSame = lastThree.every(e => e.message === firstMsg && e.name === lastThree[0].name);
            if (allSame) {
                agent.error(`💥 连续${ERROR_MAX}次相同错误(${firstMsg})，系统退出`);
                process.exit(3);
            }
        }
    }
    // 捕获异步异常
    process.on('unhandledRejection', async (reason, promise) => {
        agent.error('⚠️ 未处理的Promise拒绝:', reason);
        if (reason instanceof Error) {
            handleError(reason as Error, 'unhandledRejection');
        }
    });

    // 捕获同步异常
    process.on('uncaughtException', async (error) => {
        agent.error('⚠️ 未捕获异常:', error.message);
        handleError(error, 'uncaughtException');
    });

    agent.log('🩹 全自动自愈Agent已启用');
}
// #endregion 全局异常拦截器

// ==================== 文件轮询输入 ====================
// #region 文件轮询输入
class FilePoller {
    private static instance: FilePoller | null = null;
    private timerId: NodeJS.Timeout | null = null;
    private lastSize = 0;
    private lastMtime = 0;
    private filepath = '';
    private agent: AutoHealingAgent;
    /**
     * 获取 FilePoller 单例实例
     * @param agent AutoHealingAgent 实例
     * @param filepath 要轮询的文件路径
     * @returns FilePoller 单例
     */
    static getInstance(agent: AutoHealingAgent, filepath: string): FilePoller {
        if (!FilePoller.instance) {
            FilePoller.instance = new FilePoller(agent, filepath);
        }
        return FilePoller.instance;
    }

    private constructor(agent: AutoHealingAgent, filepath: string) {
        this.agent = agent;
        this.filepath = filepath;
        this.agent.log(`轮询目标文件: ${filepath}`);
        if (!fs.existsSync(this.filepath)) {
            fs.writeFileSync(this.filepath, '');
        }
        this.timerId = setInterval(() => this.readInput(), CONFIG.POLL_INTERVAL);
    }

    /** 
     * 读取输入的文本  
     * 如果长度没变并且时间戳没变，那么就当做没有新的输入
     */
    private async readInput() {
        const stat = fs.statSync(this.filepath);
        if (stat.size === this.lastSize && stat.mtimeMs === this.lastMtime) return;
        const text = fs.readFileSync(this.filepath, 'utf8');
        this.lastSize = stat.size;
        this.lastMtime = stat.mtimeMs;
        this.process(text);
    }

    private async process(content: string) {
        // 打断上一条消息
        this.agent.stop();
        // 检测当前的数据是否有效
        let txt = content.trim();
        if (txt == '') return;
        switch (txt) {
            case 'new':
                this.agent.clean();
                return;
            default:
                this.agent.log(`文件输入消息长度: ${txt.length}`);
                await this.agent.input(txt);
        }
    }
}
// #endregion 文件轮询输入

import Fastify from 'fastify';
import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

config();
// 配置
const PORT = Number(process.env.GATEWAY_PORT!)

// 1. 创建Fastify实例
const gateway = Fastify({
    logger: false,
    forceCloseConnections: true
});
gateway.get('/exit', async () => {
    process.exit(0);
    return { status: 'ok', type: 'exit' };
});
gateway.get('/error', async () => {
    process.exit(98);
    return { status: 'ok', type: 'exit' };
});

// 2. 注册固定接口
// 健康检查
gateway.get('/health', async () => {
    return { status: 'ok', type: 'openclaw-gateway' };
});

// 外围服务注册接口
gateway.post('/register', async (request, reply) => {
    const { name, type, address } = request.body as any;
    console.log(`[注册] 服务：${name}，类型：${type}`);
    return { code: 0, msg: '注册成功' };
});

// 消息转发接口
gateway.post('/message', async (request) => {
    const { content, from } = request.body as any;
    console.log(`[消息] ${from}：${content}`);
    return { code: 0, msg: '消息已接收' };
});

// 3. 自动加载 plugins 文件夹所有ts插件
async function loadPlugins() {
    const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugins');
    if (!fs.existsSync(pluginDir)) return;

    const files = fs.readdirSync(pluginDir).filter(f => f.endsWith('.ts'));
    for (const file of files) {
        const plugin = await import(path.join(pluginDir, file));
        // 向插件传递核心对象：gateway 实例（所有能力都能访问）
        await gateway.register(plugin.default);
        console.log(`[插件] 加载成功：${file}`);
    }
}

// 4. 启动网关
async function start() {
    // 加载插件
    await loadPlugins();
    // 监听服务器
    await gateway.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`[网关] 运行中：127.0.0.1:${PORT}`);
}

start();
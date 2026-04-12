import { FastifyPluginAsync } from 'fastify';
/**
 * 创建异步插件函数
 * @param plg 异步插件函数，通过 fastify.register(plg) 进行注册
 */
function createFastifyPluginAsync(plg: FastifyPluginAsync): FastifyPluginAsync {
    return plg
}

export default createFastifyPluginAsync(async function demoPlugin(fastify) {
    console.log('[Demo插件] 初始化成功');

    // 插件里可以扩展新接口（不修改内核代码）
    fastify.get('/plugins/test', async () => {
        return { msg: '插件接口工作正常' };
    });
});
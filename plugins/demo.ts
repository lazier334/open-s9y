import type { FastifyPluginAsync } from 'fastify'
export default ((plugin: FastifyPluginAsync) => plugin)(
    /** 异步插件函数，通过 fastify.register(plugin) 进行注册 */
    async function demoPlugin(fastify) {
        console.log('[Demo插件] 初始化成功')
        fastify.get('/plugins/demo', async () => {
            return { msg: '插件接口工作正常' }
        })
    }
)
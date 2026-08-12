import { type FunAdapterType } from "../src/adapters/fun-adapter.ts";

/**
 * 自定义api等功能  
 * 只要不导出pivot就不会被注册成pivot  
 * 可以通过 funAdapter 拿到其他对象  
 * 使用 _ 开始命名的文件只会在初次加载，dev 模式后续热更新不会重新加载 _ 开头的模块
 */
export default (funAdapter: FunAdapterType) => {
    const fastify = funAdapter.server.fastify;
        fastify.get("/shutdown", async (_request, reply) => {
            reply.code(202).send({ status: "正在关机中" });
            console.log('系统正在关机中...');
            funAdapter.server?.close().catch(() => process.exit(0));
        });
}
/**
 * TODO 这个网关代理程序不完整，还需要后面继续调试连通性
 * TODO 这个网关代理程序不完整，还需要后面继续调试连通性
 * TODO 这个网关代理程序不完整，还需要后面继续调试连通性
 */
import { FunPivot, Message, MessagePayload } from "../sdk/fun-pivot-sdk.ts";
import { HttpPivot } from "../sdk/http-pivot-sdk.ts";

interface UpstreamConfig {
    gatewayUrl: string;
    enabled: boolean;
    pivotId: string;
    capabilities?: string[];
    /** 由代理创建 */
    pivot?: HttpPivot
}
const gatewayProxy = createGatewayProxy([
    // 示例配置（取消注释并修改即可启用）
    { gatewayUrl: "http://localhost:3000", enabled: false, pivotId: "proxy-to-a", capabilities: ["calc"] },
]);

export const pivot = new FunPivot({
    pivotId: "gateway-proxy",
    type: "gateway",
    capabilities: ['gatewayProxy'],
    /**
     * 收到本地网关转发的任务，转发给第一个可用的上游网关
     */
    async onMessage(message) {
        const pivots = gatewayProxy.allPivot();
        if (pivots.length === 0) throw new Error("无可用上游网关");

        const pivot = pivots[0];

        // 重新构造消息，移除本地网关注入的 targetId，让上游网关重新路由
        const forwardMessage = new Message({
            senderId: message.senderId,
            payload: new MessagePayload({
                ...message.payload,
                timestamp: Date.now(),
                sync: true
            }),
            taskId: message.taskId,
        });

        const reMsg = await pivot.sendToServer(forwardMessage) as Message;

        if (!reMsg.error) {
            throw new Error(`上游网关调用失败: ${reMsg.error}`);
        }
        return reMsg;
    },
});

export default pivot;

/**
 * 创建网关代理对象
 */
function createGatewayProxy(uc: UpstreamConfig[]) {
    /**
     * 网关代理
     * - 同时维护多个到上游网关的 HTTP 连接
     * - 收到本地任务后，转发给上游网关处理
     *
     * 配置直接修改 CONFIG 数组
     */
    class GatewayProxy {
        /**
         * 上游网关配置列表
         * - 直接修改此数组来增删改目标网关
         * - enabled 控制是否连接
         */
        upstreamConfig: UpstreamConfig[] = [];

        constructor(upstreamConfig: UpstreamConfig[]) {
            this.upstreamConfig = upstreamConfig;
            this.createHttpPivots();
        }

        private async onMessage(message: Message) { }

        /**
         * 更新处理上游传递的消息的函数
         * @param onMessage 
         */
        updateOnMessage(onMessage: (message: Message) => Promise<void>) {
            this.onMessage = onMessage;
        }
        /**
         * 调用该方法创建上游支点，需要传递接收到上游支点时的处理函数
         * @param onMessage 
         */
        async createHttpPivots(): Promise<void> {
            const self = this;
            for (const cfg of this.upstreamConfig) {
                if (cfg.enabled) {
                    if (!cfg.pivot) {
                        // 在此处创建httpPivot
                        cfg.pivot = new HttpPivot({
                            ...cfg,
                            type: 'gateway',
                            onMessage(message) {
                                return self.onMessage(message);
                            }
                        });
                    }
                } else {
                    if (cfg.pivot) {
                        // 在此处断开连接
                        cfg.pivot.disconnect();
                    }
                }
            }
        }
        /** 断开全部连接 */
        disconnectAllPivots() {
            for (const cfg of this.upstreamConfig) {
                if (cfg.pivot) {
                    cfg.pivot.disconnect();
                }
            }
        }
        /** 全部的支点 */
        allPivot() {
            let pivots = [];
            for (const cfg of this.upstreamConfig) {
                if (cfg.enabled && cfg.pivot) {
                    pivots.push(cfg.pivot);
                }
            }
            return pivots;
        }
    };

    return new GatewayProxy(uc)
}
import { FunPivot } from "../sdk/fun-pivot-sdk.ts";
import { Message, MessagePayload } from "../sdk/type.ts";

const pluginPivotId = process.env.PLUGIN_PIVOT_ID ?? "router-01";
// 负载均衡使用
const assignedCounts = new Map<string, number>();

interface PivotRecord {
    pivotId: string;
    assignedCount: number;
}

export const pivot = new FunPivot({
    pivotId: pluginPivotId,
    type: 'system',
    capabilities: ["routing"],
    /**
     * 任务分发决策
     * - 从 message.payload.capabilities 提取所需能力
     * - 通过 gateway.connections 获取实时在线支点
     * - 选择 assignedCount 最小的支点
     */
    async onMessage(message: Message) {
        const requiredCaps = (message.payload?.capabilities as string[]) ?? [];
        const connections = this.funAdapter?.connections.getAll();
        if (!connections) {
            return;
        }
        // 拿到全部支点
        const all = Array.from(connections.values()).map(conn => conn.pivotInfo);
        const candidates: PivotRecord[] = [];

        // 查找支持该能力的支点
        for (const pivot of all) {
            const caps = pivot.capabilities ?? [];
            if (requiredCaps.length === 0 || requiredCaps.some((c) => caps.includes(c))) {
                candidates.push({
                    pivotId: pivot.pivotId,
                    assignedCount: assignedCounts.get(pivot.pivotId) ?? 0,
                });
            }
        }

        if (candidates.length === 0) {
            return new Message({
                error: `没有可用 Pivot 支持该能力: ${requiredCaps.join(",")}`
            });
        }

        let receiverId = null;
        // 同能力下有同名匹配的优先，否则退化到纯能力匹配
        if (message.payload.receiverName) {
            const nameMap = new Map(all.map((p) => [p.pivotId, p.name]));
            const byName = candidates.filter((c) => nameMap.get(c.pivotId) === message.payload.receiverName);
            if (byName.length > 0) {
                const selected = byName.sort((a, b) => a.assignedCount - b.assignedCount)[0];
                assignedCounts.set(selected.pivotId, selected.assignedCount + 1);
                receiverId = selected.pivotId;
            }
        }
        if (receiverId === null) {
            const selected = candidates.sort((a, b) => a.assignedCount - b.assignedCount)[0];
            assignedCounts.set(selected.pivotId, selected.assignedCount + 1);
            receiverId = selected.pivotId;
        }

        console.log('匹配到响应内容的目标pivot:', receiverId)
        return new Message({
            body: receiverId
        });
    },
});

export default pivot;


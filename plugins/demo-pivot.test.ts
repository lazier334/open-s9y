import { FunPivot } from "../sdk/fun-pivot-sdk.ts";

export const pivot = new FunPivot({
    pivotId: 'demo',
    type: 'user',
    capabilities: ['demo'],
    async onMessage(message) {
        console.log('demo收到消息', message)
    },
});

export default pivot;
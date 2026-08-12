import { FunPivot } from "../sdk/fun-pivot-sdk.ts";

export const pivot = new FunPivot({
    pivotId: 'fun',
    type: 'user',
    capabilities: ['fun'],
    async onMessage(message) {
        console.log('fun收到消息', message)
    },
});

export default pivot;
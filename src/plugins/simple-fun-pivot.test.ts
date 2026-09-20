import { FunPivot } from "../../s9y-server/lib/fun-pivot-sdk.ts";

export const pivot = new FunPivot({
    pivotId: 'fun',
    type: 'user',
    capabilities: ['fun'],
    async onMessage(message) {
        console.log(this.name, '收到消息', message)
    },
});

export default pivot;
import { type FunAdapterType } from "../src/adapters/fun-adapter.ts";
import { FunPivot } from "../sdk/fun-pivot-sdk.ts";
import { MessagePayload } from "../sdk/type.ts";

export default (funAdapter: FunAdapterType) => {
    const pivot = new FunPivot({
        pivotId: 'test2',
        type: 'user',
        capabilities: ['test2'],
        async onMessage(message) {
            console.log('t2收到消息', message)
        }
    });
    setTimeout(() => {
        pivot.sendToServer({
            payload: new MessagePayload({
                capabilities: ['test'],
                sync: true
            }),
            // receiverId: 'test'  
        }).then(re => console.log('t2发送消息获得响应:', re))
            .catch(re => console.log('t2出现异常:', re))
    }, 1000);
    return pivot
};
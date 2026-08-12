import { type FunAdapterType } from "../src/adapters/fun-adapter.ts";
import { FunPivot, MessagePayload } from "../sdk/fun-pivot-sdk.ts";

export default (funAdapter: FunAdapterType) => {
    const pivot = new FunPivot({
        pivotId: 'fun-test2',
        type: 'user',
        capabilities: ['fun-test2'],
        async onMessage(message) {
            console.log('t2收到消息', message)
        }
    });
    setTimeout(() => {
        pivot.sendToServer({
            payload: new MessagePayload({
                capabilities: ['fun-test'],
                sync: true
            }),
            // receiverId: 'test'  
        }).then(re => console.log('t2发送消息获得响应:', re))
            .catch(re => console.log('t2出现异常:', re))
    }, 1000);
    return pivot
};
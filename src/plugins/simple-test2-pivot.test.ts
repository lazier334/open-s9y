import { type FunAdapterType } from "../../s9y-server/adapters/fun-adapter.ts";
import { MessagePayload } from "@open-s9y/sdk";
import { FunPivot } from "../../s9y-server/lib/fun-pivot-sdk.ts";

export default (funAdapter: FunAdapterType) => {
    const pivot = new FunPivot({
        pivotId: 'fun-test2',
        type: 'user',
        capabilities: ['fun-test2'],
        async onMessage(message) {
            console.log(this.name, '收到消息', message)
        }
    });
    setTimeout(() => {
        pivot.sendToServer({
            payload: new MessagePayload({
                capabilities: ['fun-test'],
                sync: true
            }),
            // receiverId: 'test'  
        }).then(re => console.log('fun-test2 发送消息获得响应:', re))
            .catch(re => console.log('fun-test2 出现异常:', re))
    }, 1000);
    return pivot
};
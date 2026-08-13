import { type FunAdapterType } from "../s9y-server/adapters/fun-adapter.ts";
import { Message } from "@open-s9y/sdk";
import { FunPivot } from "../s9y-server/lib/fun-pivot-sdk.ts";

export default (funAdapter: FunAdapterType) => {
    const pivot = new FunPivot({
        pivotId: 'fun-test',
        capabilities: ['fun-test'],
        type: 'user',
        async onMessage(message) {
            console.log(this.name, '收到消息,正在进行回复', message)
            return new Message({
                body: 'Hello!'
            })
        }
    });
    return pivot
};
import { type FunAdapterType } from "../src/adapters/fun-adapter.ts";
import { FunPivot, Message } from "../sdk/fun-pivot-sdk.ts";

export default (funAdapter: FunAdapterType) => {
    const pivot = new FunPivot({
        pivotId: 'fun-test',
        capabilities: ['fun-test'],
        type: 'user',
        async onMessage(message) {
            console.log('t1收到消息,正在进行回复', message)
            return new Message({
                body: 'Hello!'
            })
        }
    });
    return pivot
};
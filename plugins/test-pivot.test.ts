import { Message } from "../sdk/type.ts";
import { type FunAdapterType } from "../src/adapters/fun-adapter.ts";
import { FunPivot } from "../sdk/fun-pivot-sdk.ts";

export default (funAdapter: FunAdapterType) => {
    const pivot = new FunPivot({
        pivotId: 'test',
        capabilities: ['test'],
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
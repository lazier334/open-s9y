import { Message } from "@open-s9y/sdk";
import { adapters, FunPivot } from "@open-s9y/gateway";

export default (funAdapter: adapters.FunAdapterType) => {
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
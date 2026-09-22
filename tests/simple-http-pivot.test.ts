import { HttpPivot, Message, MessagePayload } from '@open-s9y/sdk'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const __filename = import.meta.filename.replaceAll('\\', '/').split('/').pop() || 'tests';
const KEY_NAME = process.env.AUDIT_KEY_NAME ?? "s9y-key";

const pivot = new HttpPivot({
    gatewayUrl: process.env.GATEWAY_URL_HTTP ?? 'https://localhost:10000',
    headers: {
        cookie: `${KEY_NAME}=user`
    },
    pivotId: __filename,
    type: 'user',
    capabilities: [__filename],
    async onMessage(message) {
        console.log(this.name, '收到消息', message)
    },
});

(async () => {
    console.log('发起同步消息');
    let re = await pivot.sendToServer(new Message({
        receiverId: 'test',
        body: 'sync hey!',
        payload: new MessagePayload({
            sync: true
        })
    }));
    console.log('同步的消息结果:', re)

    console.log('---');
    console.log('发起异步消息');
    re = await pivot.sendToServer(new Message({
        receiverId: 'test',
        body: 'hey!'
    }));
    console.log('异步的消息结果:', re)
})()
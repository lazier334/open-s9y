import { HttpPivot, Message } from '@open-s9y/sdk'

const KEY_NAME = process.env.AUDIT_KEY_NAME ?? "s9y-key";

const pivot = new HttpPivot({
    gatewayUrl: process.env.GATEWAY_URL_HTTP ?? 'http://localhost:10000',
    headers: {
        cookie: `${KEY_NAME}=user`
    },
    pivotId: 'test',
    type: 'user',
    capabilities: ['test'],
    async onMessage(message) {
        console.log(this.name, '收到消息', message);
        return new Message({
            body: `Hello! Date: ${new Date().toLocaleString()}\nYou say to me:${message.body}`
        })
    },
});
pivot.connect();
import { HttpPivot, Message } from '@open-s9y/sdk'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const KEY_NAME = process.env.AUDIT_KEY_NAME ?? "s9y-key";

const pivot = new HttpPivot({
    gatewayUrl: process.env.GATEWAY_URL_HTTP ?? 'https://localhost:10000',
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
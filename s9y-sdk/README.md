<p align="center">
  <img src="https://lazier334.com/s9y/logo.png" alt="logo" height="200" />
</p>

<h1 align="center" id="title">@open-s9y/sdk</h1>

<p align="center">
  <b>递归委托协议</b><br>
  <i>两个原语，无限杠杆</i>
</p>

<p align="center">
  <a href="https://github.com/lazier334/open-s9y" target="_blank">
    open-s9y
  </a>
   •
  <a href="https://github.com/lazier334/open-s9y-auto" target="_blank">
    open-s9y-auto
  </a>
</p>

---

## s9ysdk 是什么？

s9ysdk 是用于快速开发 [open-s9y](https://github.com/lazier334/open-s9y) 的Pivot的包，处理了消息匹配与定义类型等功能。

## 快速使用 s9ysdk
1. 前置条件: 需要启动网关 [详情请查看open-s9y项目](https://github.com/lazier334/open-s9y)
2. 安装sdk包 `npm i @open-s9y/sdk`
3. 开发 [Pivot](#Pivot示例) `touch pivot.ts`
4. 启动Pivot接入网关 `node pivot.ts`

---

## Pivot示例

### http Pivot
```js
import { HttpPivot, Message } from '@open-s9y/sdk'

const pivot = new HttpPivot({
    gatewayUrl: process.env.GATEWAY_URL_HTTP ?? 'http://localhost:3000',
    headers: {
        // 用于身份验证
        cookie: `${process.env.AUDIT_KEY_NAME ?? "s9y-key"}=user`
    },
    pivotId: 'example-http',
    type: 'user',
    capabilities: ['example-http'],
    async onMessage(message) {
        console.log(this.name, '收到消息', message)
    },
});

pivot.sendToServer(new Message({
    // 消息接收者
    receiverId: 'test',
    // 消息内容
    body: 'hey!'
}));
```

### ws Pivot
```js
import { WsPivot, Message } from '@open-s9y/sdk'

const pivot = new WsPivot({
    gatewayUrl: process.env.GATEWAY_URL_WS ?? 'ws://localhost:3000',
    headers: {
        // 用于身份验证
        cookie: `${process.env.AUDIT_KEY_NAME ?? "s9y-key"}=user`
    },
    pivotId: 'example-ws',
    type: 'user',
    capabilities: ['example-ws'],
    async onMessage(message) {
        console.log(this.name, '收到消息', message)
    },
});

pivot.sendToServer(new Message({
    // 消息接收者
    receiverId: 'test',
    // 消息内容
    body: 'hey!'
}));
```

---

## 许可

MIT License — 详见 [LICENSE](LICENSE)。

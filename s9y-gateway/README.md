<p align="center">
  <img src="https://lazier334.com/s9y/logo.png" alt="logo" height="200" />
</p>

<h1 align="center" id="title">@open-s9y/gateway</h1>

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

## s9ygateway 是什么？

s9ygateway 是用于快速开发 [open-s9y](https://github.com/lazier334/open-s9y) 网关的包，处理了消息匹配与定义类型等功能。预留了两个主要功能
* `gateway.loadAdapter(adapterClass)` 用于添加自定义 `adapter`
* `gateway({ funPivotDir: 'pivots path' })` 用于指定自己的`Pivots目录`配置与其他配置

## 快速使用 s9ygateway
1. 安装gateway包 `npm i @open-s9y/gateway`
2. 创建并开发 [index.ts](#index主程序) `touch index.ts`
3. 启动网关 `node index.ts`

---

## index主程序

```js
import path from 'path'
import gateway from '@open-s9y/gateway'
// import { S9yAdapter } from "@open-s9y/gateway";

// 定义插件路径
const pluginPath = path.join(import.meta.dirname, '../plugins');
// 启动网关
const server = gateway({ funPivotDir: pluginPath });
// 可选加载自定义的 adapter
// server.loadAdapter(class A extends S9yAdapter { })
```

---

## 许可

MIT License — 详见 [LICENSE](LICENSE)。

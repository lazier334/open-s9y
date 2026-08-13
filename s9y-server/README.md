<p align="center">
  <img src="https://lazier334.com/s9y/logo.png" alt="logo" height="200" />
</p>

<h1 align="center" id="title">@open-s9y/server</h1>

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

## s9yserver 是什么？

s9yserver 是用于快速开发 [open-s9y](https://github.com/lazier334/open-s9y) 网关的包，处理了消息匹配与定义类型等功能。预留了两个主要功能 
* `gateway.loadAdapter(adapterClass)` 用于添加自定义 `adapter`
* `server({ funPivotDir: 'plugin path' })` 用于指定自己的`插件与Pivots目录`配置与其他配置

## 快速使用 s9yserver
1. 安装sdk包 `npm i @open-s9y/sdk`
2. 开发 [index.ts](#index主程序) `touch index.ts`
4. 启动网关 `node index.ts`

---

## index主程序

```js
import path from 'path'
import server from '@open-s9y/server'
// import { S9yAdapter } from "@open-s9y/server";

// 定义插件路径
const pluginPath = path.join(import.meta.dirname, '../plugins');
// 启动服务
const gateway = server({ funPivotDir: pluginPath });
// 可选加载自定义的 adapter
// gateway.loadAdapter(class A extends S9yAdapter { })
```

---

## 许可

MIT License — 详见 [LICENSE](LICENSE)。

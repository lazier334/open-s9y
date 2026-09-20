<p align="center">
  <img src="https://lazier334.com/s9y/logo.png" alt="logo" height="200" />
</p>
<p align="right">
  <a href="README.EN.md">English</a> | <b>中文</b>
</p>

<h1 align="center" id="title">s9y (Singularity / 奇点)</h1>

<p align="center">
  <b>递归委托协议</b><br>
  <i>两个原语，无限杠杆</i>
</p>

<p align="center">
  <a href="#philosophy">哲学</a> •
  <a href="#features">特性</a> •
  <a href="https://github.com/lazier334/open-s9y-auto" target="_blank">open-s9y-auto</a>
</p>

---

## s9y、open-s9y、open-s9y-auto 的关系是什么？
**`open-s9y项目`** 是 **`s9y协议`** 的一个协议实现基础程序。  
<a href="https://github.com/lazier334/open-s9y-auto" target="_blank">open-s9y-auto</a> 是 <a href="https://github.com/lazier334/open-s9y" target="_blank">open-s9y</a> 的拓展程序。

## s9y 是什么？

s9y 不是又一个 API 网关。它是**组织协议**，由两个原语构成：

- **`register(capabilities)`** — "我存在，且可以被雇佣"
- **`push(task)`** — "执行这个任务"

这两个原语足以表达任意递归委托网络：AI 智能体、人类组织、生物系统、或 IoT 集群。

## 快速启动 open-s9y
1. 确保已经安装 <a href="https://nodejs.org/" target="_blank">NodeJs</a> 
2. [下载仓库代码](https://github.com/lazier334/open-s9y/archive/refs/heads/main.zip) (也可以使用 <a href="https://git-scm.com/install/windows" target="_blank">Git</a> 等工具拉取代码: `git clone https://github.com/lazier334/open-s9y`)
3. 使用终端来启动程序 `npm start`

---

## <a id="philosophy" href="#title">哲学：为什么是奇点？为什么是支点？</a>

### Singularity: 奇点

s9y 所指的是**结构的奇点**：

> 当一套通信原语（`register` / `push`）能够统一描述从 1B 参数模型到 70 亿人口的文明、从神经元到汽车 ECU 时，**规则的复杂度不再随系统的规模而增长**——它始终是 2 个动作。

换言之，描述任何系统的**成本**不再取决于系统有多大，而取决于这套原语能否捕捉其本质互动。跨过这个临界点后，不同领域的控制方程被统一，之前分散的现象得以用同一种语言建模。

| 领域       | s9y 之前                         | s9y 之后            |
| ---------- | -------------------------------- | ------------------- |
| AI 工程    | OpenAI API / LangChain / AutoGen | `register` + `push` |
| 社会模拟   | NetLogo / MASON 专用语法         | `register` + `push` |
| IoT 控制   | MQTT / CoAP / HTTP 混用          | `register` + `push` |
| 分布式计算 | RPC / 消息队列 / Serverless      | `register` + `push` |

**真正的奇点不是"一个模型做所有事"，而是"所有系统终于能用同一种语言对话"。**

### Pivot: 支点

阿基米德说："给我一个支点，我能撬动地球。"

物理上的支点需要三个条件：
1. **刚性** —— 不形变，力才能传递
2. **可定位** —— 知道支点在哪里
3. **可承载** —— 能承受杠杆的压力

s9y 的 pivot 对应：

| 物理支点   | s9y Pivot                                                          |
| ---------- | ------------------------------------------------------------------ |
| **刚性**   | 两个原语的**最小完备性**——不增不减，协议语义保持刚性不变           |
| **可定位** | `register` 时的唯一标识 + 能力声明——我知道这个支点在哪里、能干什么 |
| **可承载** | `push` 的契约——我能把任务压上去，它必须响应                        |

> **Pivot** 是 s9y 系统中的最小可雇佣单元（Minimal Employable Unit）。它构成一个杠杆点，因为（1）它使协议语义保持刚性不变，（2）它通过能力注册被定位，（3）它能承受委托任务而不向雇主暴露内部实现（递归不透明性）。

### 递归杠杆：无限延伸

阿基米德的杠杆需要**一个固定支点**。s9y 允许**递归支点**——每个 pivot 本身又可以成为杠杆，雇佣更小的 pivot。

```
地球（问题）
  │
  └─ 杠杆 ──→ 大脑 pivot（支点）
                 │
                 └─ 杠杆 ──→ 代码 pivot（支点）
                                │
                                └─ 杠杆 ──→ 语法检查 pivot（支点）
```

**每一层都是支点，每一层都在撬动下一层。**

这不是物理上的无限，而是**递归委托带来的能力覆盖倍增**：
- 一个 3B 参数的"大脑"pivot 可以协调 10 个 7B 专家 pivot
- 每个 7B pivot 又可以委托给 10 个 1B 工具 pivot
- 可调度的总参数量上限为 **173B**，但任意时刻激活的参数量仅为最大路径上的和（如 3+7+1=11B）——**既覆盖了大规模能力，又保持了轻量执行**。

---

## <a id="features" href="#title">特性</a>

### 可变的传输层

- **内存级通信** —— 同进程内函数调用（零拷贝、零延迟）
- **HTTP** —— 跨容器或跨节点的 RESTful 委托
- **WebSocket** —— 双向流式、进度推送、长连接会话
- **其他方式** —— 只需要能传输即可

多种模式共享**同一套原语**。传输层可替换，业务逻辑无需改动。

---

### s9y 不做什么

最小协议的力量来自**克制**：

1. **不做共识 / 一致性保证** —— 冲突仲裁是大脑的职责
2. **不做实时硬同步** —— 纳秒级同步需要额外的时间协议层
3. **不做价值判断** —— 伦理与合法性是组织层的职责

这些边界不是缺陷，而是**设计选择**。正因为我们不把这些塞进协议，s9y 才能应用于如此广泛的领域。若需要完整功能，请使用 <a href="https://github.com/lazier334/open-s9y-auto" target="_blank">open-s9y-auto</a> 项目

---

## 许可

MIT License — 详见 [LICENSE](LICENSE)。
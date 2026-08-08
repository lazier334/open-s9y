# 测试项由ai生成

## 测试结构

```
tests/
├── lib/
│   └── result.ts          # 公共测试结果模块（统一输出 + 日志保存）
├── logs/                   # 测试日志输出目录（自动创建）
├── test-sdk.ts             # SDK 单元测试（无需网关）
├── test-gateway.ts         # Gateway 集成测试（需网关）
├── test-broker.ts          # Broker 端到端测试（需网关）
├── test-auth.ts            # 认证功能测试（需网关）
└── Tests.md                # 本文件
```

## 测试命令

```sh
# ═══ 单元测试（无需网关）═══
node --experimental-strip-types tests/test-sdk.ts

# ═══ 集成测试（需先启动网关）═══
# 终端 1: 启动网关
node --env-file=.env.development --experimental-strip-types src/index.ts

# 终端 2: 运行测试
node --experimental-strip-types tests/test-gateway.ts
node --experimental-strip-types tests/test-broker.ts
node --experimental-strip-types tests/test-auth.ts
```

## 测试日志

测试结果自动保存到 `tests/logs/` 目录，格式：

```
测试项: xxx
需求: xxxxx
结果: 通过 / 失败 — 原因
```

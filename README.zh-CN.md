# QuotaRouter

跑在本地的代理,夹在 Claude Code 和你的 Anthropic 兼容 API 供应商之间。你把手上的端点都丢给它,它按优先级挑可用的那个,限流或出错自动切换,高优先级恢复后自动切回——且必须真实流量确认才算恢复,不是猜的。

单文件、零 npm 依赖、Dashboard 不重启改配置。

<a href="./README.md">English</a> · <a href="#安装">安装</a> · <a href="#工作原理">工作原理</a> · <a href="#配置">配置</a>

![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![Dependencies](https://img.shields.io/badge/dependencies-0-blue) ![Tests](https://img.shields.io/badge/tests-50%2F50-brightgreen) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

<!-- ![QuotaRouter dashboard](docs/dashboard.png) -->
<!-- ASCII 示意图占位 — 等真实图就位替换 -->

```
                ┌─────────────────── QuotaRouter (127.0.0.1:8787) ───────────────────┐
                │                                                                    │
   Claude Code  │  ┌── 请求体改写 ───┐    ┌── 挑后端 ─────────┐    ┌── 转发 ─────┐   │
 POST /v1/msg ──┼─▶│  modelOverride │──▶ │  pinned? → 优先级 │──▶│ 2xx → 流式  │──▶ Claude Code
                │  │  清理空 text 块 │    │  跳过 hardCooldown│   │ 429 → 切换  │   │
                │  └─────────────────┘    └───────────────────┘   └─────────────┘   │
                │                                       │                            │
                │                  ┌────────────────────┼────────────────────┐       │
                │                  ▼                    ▼                    ▼       │
                │           GLM plan #1         自建 IP plan          Kimi coding plan│
                └─────────────────────────────────────────────────────────────────────┘
                ▲                                                                             │
                │            ┌────────── Dashboard (127.0.0.1:8788) ──────────┐             │
                └────────────│  实时状态 · 内联改配置 · 不重启                │◀────────────┘
                             └────────────────────────────────────────────────┘
```

## 安装

```bash
git clone https://github.com/akushonkamen/QuotaRouter.git
cd QuotaRouter
cp config.example.json config.json   # 填入你的后端和 token
node server.js
```

让 Claude Code 指过来——`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

Dashboard 在 `http://127.0.0.1:8788`(首次启动 stdout 打印 token)。

## 工作原理

两个本地 HTTP 服务:**代理** `8787`(Claude Code 对接)和 **Dashboard** `8788`(你盯盘和操控)。每个请求走五步:

1. **请求体改写** — 应用 `modelOverride`(按后端改写 `model` 字段),清理空 text 块(Kimi 拒绝空块、GLM 接受,统一行为)。
2. **挑后端** — 先看 `pinnedBackend`(如设了,跳过硬冷却),然后按优先级升序找第一个健康且没试过的后端。都没有就兜底 `probe-pending`,再不行选最快恢复的软冷却。
3. **转发** — 按后端的 `firstByteTimeoutMs`(推理模型出第一个 token 前要想很久)和每次 chunk 重置的 idle 超时控制。
4. **分类响应**:
   - `2xx` → 流式回 Claude Code,标记 healthy。
   - `401/403` → 读 body,分类成 `auth` 还是 `model-access-denied`,硬冷却 1h+。
   - `429` + `retry-after ≤ 60s` → 瞬时限速。如被 pin 或没别的可用,等几秒重试同一后端(总共上限 45s)。
   - `429` + `retry-after > 60s` / `5xx` / 超时 → 硬冷却,立刻切下一个。
5. **循环**直到成功或所有后端耗尽(返回 `502`)。

两个后台定时器:
- 每 `healthCheckIntervalMs` — 对 `probe-pending` 后端发被动 `HEAD /`。只有 `2xx/3xx` 才算恢复;`4xx` 不算健康。
- 每 5s — 到期的冷却从 `hardCooldown` → `probe-pending`,绝不直接翻 `healthy`。

### 关键行为:冷却到期 ≠ 健康

后端的 retry-after 计时归零不会直接翻回"可用"。它进入 `probe-pending`,必须被动探针返回 2xx/3xx **或**真实请求成功才算恢复。没有这层,4xx 死掉的后端(key 过期、模型权限被吊销)每个冷却窗口都会抢占正在工作的低优先级后端。

### 状态机

```
   ┌─────────┐  429长 / 5xx / 401-403     ┌──────────────┐
   │ healthy │ ──────────────────────────▶│ hardCooldown │
   └─────────┘                            └──────┬───────┘
        ▲  2xx 确认(真实请求 OR                  │ 冷却到期
        │  被动 HEAD 探针 2xx/3xx)               ▼
        │                              ┌─────────────────┐
        └──────────────────────────────│ probe-pending   │
                                       └────────┬────────┘
                                         再次失败 │
                                       回到 hardCooldown
```

## 配置

`config.json`(gitignore——放真实 token)。从 `config.example.json` 复制起步。

| Key | 默认 | 说明 |
|---|---|---|
| `proxyPort` | `8787` | 代理监听端口。 |
| `dashboardPort` | `8788` | Dashboard 监听端口。 |
| `firstByteTimeoutMs` | `15000` | 全局首字节超时预算。后端可单独设 `firstByteTimeoutMs` 覆盖。 |
| `idleTimeoutMs` | `60000` | 流式期间 chunk 之间的最大间隔。 |
| `healthCheckIntervalMs` | `20000` | 被动探针 `probe-pending` 后端的间隔。 |
| `errorCooldownMs` | `30000` | 失败无服务端 retry-after 时的短冷却。 |
| `preemptOnRecovery` | `true` | `true`:高优先级恢复立刻抢占。`false`:粘住当前直到失败。 |
| `pinnedBackend` | `null` | 手动覆盖——每个请求强制先走这个后端(尊重硬冷却)。Dashboard 可改。 |
| `businessHours` | — | `{ enabled, days: [0-6], startHour, endHour }`。`businessHoursAware` 后端失败无 retry-after 时用。 |
| `dashboardToken` | auto | 未设时首次启动自动生成。`null`/`""` 关闭鉴权。 |

### 后端字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 唯一标识。 |
| `baseUrl` | ✅ | 上游 URL。 |
| `token` | ✅ | API key。同时作为 `x-api-key` 和 `authorization: Bearer` 发送。 |
| `priority` | ✅ | 数字小的先试。 |
| `modelOverride` | 可选 | 改写请求体 `model` 字段(如 Kimi 用 `"k3"`)。 |
| `businessHoursAware` | 可选 | 窗口外冷却延长到下个窗口起点。 |
| `firstByteTimeoutMs` | 可选 | 覆盖全局首字节预算。 |

```json
{
  "backends": [
    { "name": "glm-primary", "baseUrl": "https://open.bigmodel.cn/api/anthropic", "token": "sk-...", "priority": 1 },
    { "name": "custom-ip", "baseUrl": "http://你的ip:8080", "token": "sk-...", "priority": 2, "businessHoursAware": true, "modelOverride": "GLM-5.2" },
    { "name": "kimi-coding", "baseUrl": "https://api.kimi.com/coding", "token": "sk-...", "priority": 3, "modelOverride": "k3", "firstByteTimeoutMs": 120000 }
  ]
}
```

## 后台常驻 (macOS)

launchd plist 让代理跨重启和崩溃都活着:

```bash
launchctl kickstart -k gui/$(id -u)/com.<user>.claude-api-proxy   # 重启
launchctl bootout gui/$(id -u)/com.<user>.claude-api-proxy        # 停
```

状态(`requests` / `errors` 计数)通过 `logs/state.json` 跨重启保留。

## 测试

```bash
cp server.js test/server.js
node test/run.js
```

50 条断言覆盖:优先级路由、故障转移、抢占 vs 粘住、pin、429 冷却、HTTP-date retry-after、空 text 块清理、按后端超时、全挂返回 502、SSE 流式、后端增删 API、配置校验、token 隔离、统计持久化、Dashboard 鉴权、业务时段窗口。

## License

MIT

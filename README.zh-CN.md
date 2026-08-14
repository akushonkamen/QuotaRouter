<p align="center">
  <h1 align="center">QuotaRouter</h1>
  <p align="center">
    Claude Code / Anthropic 兼容 API 的多后端自动切换代理
    <br />
    <a href="./README.md">English</a> ·
    <a href="#安装">安装</a> ·
    <a href="#工作原理">工作原理</a> ·
    <a href="#为什么选这个">为什么选这个</a> ·
    <a href="#配置">配置</a> ·
    <a href="#后台常驻-macos">launchd</a>
  </p>
  <p align="center">
    <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-green" />
    <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-blue" />
    <img alt="Tests" src="https://img.shields.io/badge/tests-50%2F50-brightgreen" />
    <img alt="License" src="https://img.shields.io/badge/license-MIT-lightgrey" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-macos%20%7C%20linux%20%7C%20wsl-informational" />
  </p>
</p>

---

跑在本地的代理,夹在 Claude Code 和你的 API 供应商之间。Claude Code 只需一次性指向 `127.0.0.1:8787`,QuotaRouter 就会按你设的优先级挑可用后端,限流/出错自动切换,高优先级恢复后立刻切回——**而且必须真实流量确认才算恢复,不是猜的**。单文件、零 npm 依赖、Dashboard 不重启改配置。

<!-- ![QuotaRouter dashboard](docs/dashboard.png) -->
<!-- ASCII 示意图占位 — 等真实图就位替换 -->

```
                ┌─────────────────────────── QuotaRouter (127.0.0.1:8787) ───────────────────────────┐
                │                                                                          │
   Claude Code  │  ┌── Body 改写 ─────┐    ┌── 后端挑选 ────────┐    ┌── 转发 ──────┐               │
 POST /v1/msg ──┼─▶│  modelOverride   │──▶ │  pinned? → 优先级 │──▶│ 2xx → 流式 ─┼──▶ Claude Code
                │  │  清理空 text 块  │    │  跳过 hardCooldown │   │ 401/403 →1h│               │
                │  └──────────────────┘    │  probe-pending 兜底│  │ 429≤60s→等 │               │
                │                          └────────────────────┘   │ 429>60s→切 │               │
                │                                       │              └──────┬─────┘               │
                │                  ┌──────────────────┼─────────────────────┼─────────────────────┐│
                │                  ▼                   ▼                     ▼                    ▼│
                │           GLM primary         custom-ip-8080         Kimi coding         GLM secondary│
                │           (P1 可用)        (P2 硬冷却中)         (P3, k3 模型)       (P4 挂了)    │
                └────────────────────────────────────────────────────────────────────────────────────┘
                ▲                                                                                         │
                │            ┌──────────── Dashboard (127.0.0.1:8788) ────────────┐                     │
                └────────────│  实时状态 · 内联改 优先级/pin/业务时段/增删后端    │◀────────────────────┘
                             │  token 保护 · 配置改动即时生效不重启              │
                             └──────────────────────────────────────────────────┘
```

## 为什么选这个

市面上的 Claude API 路由基本两类:要么是 SaaS 想要你的 key,要么是框架带 200 个传递依赖。QuotaRouter 都不是。

| | QuotaRouter | LiteLLM | Claude Code Router | 单行脚本 |
|---|---|---|---|---|
| **需要 npm install** | ❌ 零依赖 | ✅ | ✅ | 看情况 |
| **单文件** | ✅ `server.js` | ❌ | ❌ | ✅ |
| **Live dashboard,不重启改配置** | ✅ | ❌ | ❌ | ❌ |
| **按优先级切换** | ✅ | 轮询/随机 | 规则式 | ❌ |
| **恢复必须真实流量确认** | ✅ | ❌ | ❌ | ❌ |
| **业务时段感知冷却** | ✅ | ❌ | ❌ | ❌ |
| **401/403 模型权限分类** | ✅ | 部分 | ❌ | ❌ |
| **跨厂商请求体归一化** | ✅ | 预设 | ✅ | ❌ |

最核心的差异一句话:**冷却到期 ≠ 健康**。多数路由看到 retry-after 计时归零就把后端翻回"可用"。QuotaRouter 不这样——冷却到期的后端进入 `probe-pending`(探针待确认),必须被动 HEAD 探针返回 2xx/3xx **或**真实请求成功才能转回 healthy。一个 4xx 的死后端(key 过期、模型权限被吊销)无法靠被动探针区分,就永远不会在每个冷却窗口里抢占正在工作的低优先级后端。

## 特性

- 🎯 **按优先级路由** — `priority: 1` 先试,`2` 次之,以此类推。高优先级恢复后立即抢占低优先级(或设 `preemptOnRecovery: false` 改成粘住当前后端直到它失败)。
- 🛡️ **恢复必须真实流量确认** — 冷却到期只是"解锁"(进入 `probe-pending`),被动 HEAD 探针 **或**真实请求必须确认一次才能抢占优先级。4xx 死掉的后端不会被凭空复活。
- ⏳ **硬冷却 vs 软冷却** — 服务端发的长 `retry-after`(429 配额耗尽)锁成硬冷却;手动 pin 和"无其他可用"兜底都尊重硬冷却。短限速(≤60s)直接等几秒重试**同一个**后端,不把流量弹到别的后端。
- 🕘 **业务时段感知冷却** — 失败没有服务端 retry-after 时(连接挂掉、普通 5xx),`businessHoursAware` 的后端在窗口外冷却到**下个窗口起点**,不在凌晨反复重试空打。
- 🧩 **跨厂商请求体归一化** — `modelOverride` 按后端改写请求体的 `model` 字段(Claude Code 永远只发本地那一个名;GLM 要 `GLM-5.2`,Kimi 要 `k3`)。空 text 块(CC 中断的 turn 会产生)自动清理,Kimi 不再因为 GLM 能接受的空块而 400。
- 📊 **Live Dashboard** — token 保护、暗色、单页。内联改优先级、抢占策略、业务时段、当前 pin 的 API;表单增删后端。改动写入 `config.json` 即时生效,**不重启**。
- 🔒 **token 隔离** — `config.json` gitignore;`/api/status` 永不暴露 token;`dashboardToken` 首次启动自动生成。
- 📈 **统计持久化** — 请求/错误计数通过 `logs/state.json` 跨重启保留(每 15s + SIGTERM/SIGINT 落盘)。应用日志 5MB × 3 份滚动。
- 🪶 **零依赖单文件** — `server.js`(~1000 行)只用 Node 内置模块。`node server.js` 直接起。没有 `npm install`、没有 lockfile 漂移、没有审计告警。
- 🧪 **50 条端到端测试** — `test/run.js` 驱动真实 `server.js` 对抗可控的 fake 上游(throttle / quota / hang / 5xx / strict / stream 模式)。

## 安装

```bash
git clone https://github.com/akushonkamen/QuotaRouter.git
cd QuotaRouter
cp config.example.json config.json   # 填入你的后端和 token
node server.js
```

然后让 Claude Code 指过来——`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

完事。Dashboard 在 `http://127.0.0.1:8788`(首次启动 stdout 打印 token,或在 `config.json` 显式设 `dashboardToken`)。

## 工作原理

QuotaRouter 跑两个本地 HTTP 服务:**代理** `127.0.0.1:8787`(Claude Code 对接)和 **Dashboard** `127.0.0.1:8788`(你盯盘和操控)。每个请求走五步:

1. **请求体改写** — `prepareBodyForBackend` 解析 JSON 体,应用 `modelOverride`(把 `model` 改成后端要的名字),清理空 text 块(包括 `tool_result.content` 里嵌套的)。非 JSON 体原样透传。
2. **挑后端** — `pickStartIndex` 先看有没有手动 `pinnedBackend`(跳过硬冷却),然后按 `priorityOrder`(优先级升序)找第一个**健康且没试过**的后端。都没有就兜底试 `probe-pending`,再不行选最快恢复的软冷却后端。
3. **转发** — `forwardOnce` 开上游请求,按后端的 `firstByteTimeoutMs`(推理模型出第一个 token 前要想很久,需要单独预算)和每次 chunk 重置的 idle 超时控制。
4. **分类响应**:
   - `2xx` → 流式回 Claude Code,标记 healthy,更新 `currentIndex`。
   - `401/403` → 读 body,分类成 `auth` 还是 `model-access-denied`,硬冷却(1h+)。
   - `429` + `retry-after ≤ 60s` → 瞬时限速。如果后端被 pin 或没别的可用,**等几秒重试同一个**(`MAX_THROTTLE_WAIT_TOTAL_MS = 45s` 兜底)。
   - `429` + `retry-after > 60s` / `5xx` / 超时 → `markUnhealthy` 硬冷却,切下一个后端。
5. **循环**直到成功或所有后端耗尽(返回 `502 all_backends_unavailable`)。

两个后台定时器保证不糊弄:

- **每 `healthCheckIntervalMs`** — 对 `probe-pending` 后端发被动 `HEAD /`。只有 `2xx/3xx` 才算恢复;`4xx` **不算**健康(401/403 后端每次真实请求都会以同样方式失败)。
- **每 5s** — 扫 `retryAfterAt` 时间戳;到期从 `hardCooldown` → `probe-pending`,绝不直接翻 `healthy`。

### 状态机

```
        ┌──────────────────────────────────────────────────────┐
        │                                                      │
        ▼                                                      │
   ┌─────────┐  429长 / 5xx / 401-403     ┌──────────────┐    │
   │ healthy │ ──────────────────────────▶│ hardCooldown │    │
   └─────────┘                            └──────┬───────┘    │
        ▲                                         │            │
        │ 2xx 确认                                │ 冷却计时   │
        │ (真实请求 OR                            │ 到期(5s   │
        │  被动 HEAD 探针 2xx/3xx)               │ 扫描)     │
        │                                         ▼            │
        │                                ┌─────────────────┐   │
        └────────────────────────────────│ probe-pending   │   │
                                         └────────┬────────┘   │
                                           再次失败 │           │
                                           ┌───────┘           │
                                           ▼                   │
                                      回到 hardCooldown ─────────┘
```

> **冷却到期 ≠ 健康。** 后端必须靠真实流量(或 2xx/3xx 被动探针)确认才能抢占正在工作的低优先级后端。这是 QuotaRouter 和多数 failover 路由的核心差异——没有这层,4xx 死掉的后端(key 过期、模型权限被吊销)每个冷却窗口都会优先于正在工作的后端被选中。

## 配置

`config.json`(gitignore——放真实 token)。从 `config.example.json` 复制一份起步。

| Key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `proxyPort` | int | `8787` | 代理监听端口(Claude Code 指这里)。 |
| `dashboardPort` | int | `8788` | Dashboard 监听端口。 |
| `firstByteTimeoutMs` | int | `15000` | 全局首字节超时预算。后端可单独设 `firstByteTimeoutMs` 覆盖(推理模型用)。 |
| `idleTimeoutMs` | int | `60000` | 流式期间 chunk 之间的最大间隔,超过就放弃。 |
| `healthCheckIntervalMs` | int | `20000` | 被动探针 `probe-pending` 后端的间隔。 |
| `errorCooldownMs` | int | `30000` | 失败无服务端 retry-after 时的短冷却。 |
| `preemptOnRecovery` | bool | `true` | `true`:永远用最高优先级可用后端。`false`:粘住当前直到失败。 |
| `pinnedBackend` | string\|null | `null` | 手动覆盖——每个请求强制先走这个后端(尊重硬冷却)。Dashboard 可改。 |
| `businessHours` | object | — | `{ enabled, days: [0-6], startHour, endHour }`。`businessHoursAware` 后端失败无 retry-after 时用。 |
| `dashboardToken` | string\|null | auto | 未设时首次启动自动生成。`null` 或 `""` 关闭鉴权。 |
| `backends[]` | array | — | 见下。 |

### 后端字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 唯一标识,Dashboard 显示。 |
| `baseUrl` | ✅ | 上游 URL(如 `https://open.bigmodel.cn/api/anthropic`)。 |
| `token` | ✅ | 该后端 API key。同时作为 `x-api-key` 和 `authorization: Bearer` 发送。 |
| `priority` | ✅ | 数字小的先试。同值按配置顺序。 |
| `modelOverride` | 可选 | 把请求体 `model` 字段改写成这个值(如 Kimi 用 `"k3"`)。 |
| `businessHoursAware` | 可选 | `true` 且 `businessHours.enabled` 时,窗口外冷却延长到下个窗口起点。 |
| `firstByteTimeoutMs` | 可选 | 覆盖全局首字节预算。 |

示例:

```json
{
  "backends": [
    {
      "name": "glm-primary",
      "baseUrl": "https://open.bigmodel.cn/api/anthropic",
      "token": "sk-...",
      "priority": 1
    },
    {
      "name": "custom-ip",
      "baseUrl": "http://你的ip:8080",
      "token": "sk-...",
      "priority": 2,
      "businessHoursAware": true,
      "modelOverride": "GLM-5.2"
    },
    {
      "name": "kimi-coding",
      "baseUrl": "https://api.kimi.com/coding",
      "token": "sk-...",
      "priority": 3,
      "modelOverride": "k3",
      "firstByteTimeoutMs": 120000
    }
  ]
}
```

## 后台常驻 (macOS)

launchd plist 让代理跨重启和崩溃都活着。示例:`~/Library/LaunchAgents/com.<user>.claude-api-proxy.plist`:

```bash
launchctl kickstart -k gui/$(id -u)/com.<user>.claude-api-proxy   # 重启
launchctl bootout gui/$(id -u)/com.<user>.claude-api-proxy        # 彻底停
```

状态(`requests` / `errors` 计数)通过 `logs/state.json` 跨重启保留。

## 测试

```bash
cp server.js test/server.js   # 测试 spawn test/server.js 用自己的 config
node test/run.js
```

50 条断言覆盖:优先级路由、故障转移、抢占 vs 粘住、pin、429 短/长冷却、HTTP-date retry-after、空 text 块清理、按后端超时、全挂返回 502、SSE 流式、后端增删 API、配置校验、token 隔离、统计持久化、Dashboard 鉴权、业务时段窗口。

## License

MIT

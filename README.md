<div align="center">

# QuotaRouter

Claude Code 的多后端自动切换代理 · 零依赖单文件 · 实时 Dashboard

[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#安装)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#)
[![Tests](https://img.shields.io/badge/tests-50%2F50-brightgreen)](#测试)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

[English](./README.en.md) · [安装](#安装) · [功能](#功能) · [它解决什么](#它解决什么) · [怎么用](#怎么用)

</div>

---

> 把手上所有 CodingPlan 的 API 都丢给它,然后照常用 Claude Code。
> 某个额度耗尽 / 限流 / 挂了,自动切到下一个;高优先级恢复了,自动切回——而且是真确认过能用了才切回,不是猜。

<div align="center">

![QuotaRouter Dashboard](./image.png)

</div>

## 它解决什么

如果你手上有多个 Anthropic 兼容 API——不同套餐、不同供应商、甚至自建服务——最烦的不是"能不能用",而是每天手动管它们:

- 😩 额度没了,手动改环境变量换另一个
- 😩 某个接口临时限流,又得改配置
- 😩 高优先级线路恢复了,不知道什么时候该切回来
- 😩 为保险只能一直盯着几个服务的状态

> **我已经有好几个能用的 API 了,能不能别让我每天手动管它们?**

可以。排好优先级,剩下的交给 QuotaRouter。

## 功能

- 🎯 **按优先级路由** — `priority: 1` 先用,额度耗尽自动切 `2`,以此类推;高优先级恢复立刻抢占回来
- 🛡️ **恢复必须真实流量确认** — 冷却到期不算恢复,必须被动探针或真实请求确认才能切回,避免反复踩回坏掉的服务
- ⏳ **硬/软冷却分级** — 服务端长 `retry-after` 锁硬冷却,pin 和兜底都尊重;短限速(≤60s)等几秒重试同一后端,不浪费切换
- 🕘 **业务时段感知** — `businessHoursAware` 后端窗口外冷却到下个窗口起点,不在凌晨空打
- 🧩 **跨厂商请求体归一化** — `modelOverride` 按后端改 `model` 字段(GLM 要 `GLM-5.2`、Kimi 要 `k3`);空 text 块自动清理,Kimi 不再 400
- 📊 **Live Dashboard** — token 保护,内联改优先级 / pin / 业务时段 / 增删后端,即时生效不重启
- 🔒 **token 隔离** — `config.json` gitignore,`/api/status` 永不暴露 token
- 🪶 **零依赖单文件** — `server.js` 只用 Node 内置模块,`node server.js` 直接起,无 `npm install`
- 🧪 **50 条端到端测试** — 真实 `server.js` 对抗 fake 上游,覆盖所有切换场景

## 怎么用

**一句话**:Claude Code 前面的一层自动挡。主线路能用就走主线路,出问题自动换备用,恢复了自动回来。想临时固定某个服务,在 Dashboard 里点一下,不用重启。

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

完事。Dashboard 在 `http://127.0.0.1:8788`(首次启动 stdout 打印 token)。**从此不用再碰这个地址**。

## 测试

```bash
cp server.js test/server.js
node test/run.js
```

50 条断言覆盖:优先级路由、故障转移、抢占 vs 粘住、pin、429 冷却、HTTP-date retry-after、空 text 块清理、按后端超时、全挂返回 502、SSE 流式、后端增删 API、配置校验、token 隔离、统计持久化、Dashboard 鉴权、业务时段窗口。

## License

MIT

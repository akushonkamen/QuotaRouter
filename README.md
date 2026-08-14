<div align="center">

# QuotaRouter

Claude Code 的多 API 自动切换工具

不用再手动换额度、换线路、盯状态。

[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#安装)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#)
[![Tests](https://img.shields.io/badge/tests-50%2F50-brightgreen)](#测试)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

[English](./README.en.md) · [安装](#安装) · [功能](#功能) · [它解决什么](#它解决什么)

</div>

---

> 把你手上的 CodingPlan API 都交给 QuotaRouter，然后照常用 Claude Code。
>
> 一个额度没了、限流了或者挂了，就自动换下一个；原来的主线路恢复以后，再自动切回来。

<div align="center">

![QuotaRouter Dashboard](./image.png)

</div>

## 它解决什么

如果你手上同时有几个 Anthropic 兼容 API，真正麻烦的通常不是没有接口，而是**接口太多，要自己管**。

比如：

* 这个套餐额度用完了，要手动换
* 某条线路突然限流，又得重新改配置
* 主线路恢复了，也不知道什么时候该切回来
* 为了不影响 Claude Code，只能隔一会儿看一次状态

QuotaRouter 就是用来把这些事情自动化的。

你只需要提前排好优先级，之后正常用 Claude Code 就行。

## 功能

* 🎯 **自动选线路**
  优先用你最想用的 API，出问题后自动切到备用。

* 🔁 **恢复后自动切回来**
  主线路恢复以后，会重新回到主线路，不需要你手动处理。

* ✅ **确认真的恢复了才切**
  不会因为“时间到了”就盲目切回去，而是确认接口确实已经能用了。

* 📌 **可以临时固定某条线路**
  想指定某个 API 时，直接在 Dashboard 里点一下。

* 🕘 **可以照顾有使用时段的线路**
  某些套餐只适合特定时间使用，也可以单独设置。

* 🔀 **兼容不同厂商的小差异**
  GLM、Kimi、自建接口之类，可以各自做适配，不用你来回改 Claude Code。

* 📊 **有一个实时 Dashboard**
  当前在用谁、谁挂了、谁在恢复，一眼就能看到。配置修改后直接生效，不用重启。

* 🪶 **很轻**
  一个文件，Node.js 直接运行，不需要 `npm install`。

## 怎么用

可以把它理解成：

> **Claude Code 前面的一层自动挡。**

主线路能用，就走主线路。

主线路出问题，就换备用。

主线路恢复，就自动回来。

平时基本不用管。

## 安装

```bash
git clone https://github.com/akushonkamen/QuotaRouter.git
cd QuotaRouter
cp config.example.json config.json
node server.js
```

然后让 Claude Code 指向 QuotaRouter：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

Dashboard：

```text
http://127.0.0.1:8788
```

首次启动时会打印登录 token。

配置好以后，基本就不用再碰 Claude Code 的 API 地址了。

## 测试

```bash
cp server.js test/server.js
node test/run.js
```
目前有 50 条测试，覆盖常见的切换、限流、恢复、固定线路、流式请求和 Dashboard 操作。

## License

MIT

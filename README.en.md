<div align="center">

# QuotaRouter

Multi-backend auto-failover proxy for Claude Code · zero-dependency single file · live Dashboard

[![Node](https://img.shields.io/badge/node-%3E%3D18-green)](#install)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue)](#)
[![Tests](https://img.shields.io/badge/tests-50%2F50-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](#license)

[中文](./README.md) · [Install](#install) · [Features](#features) · [What it solves](#what-it-solves) · [How to use](#how-to-use)

</div>

---

> Hand all your CodingPlan APIs to it, then keep using Claude Code as usual.
> When one runs out of quota / gets rate-limited / goes down, it auto-switches to the next; when the higher-priority line recovers, it switches back — but only after genuinely confirming it works, not guessing.

<div align="center">

![QuotaRouter Dashboard](./image.png)

</div>

## What it solves

If you have multiple Anthropic-compatible APIs — different plans, different providers, even self-hosted services — the real pain isn't "do they work", but managing them by hand every day:

- 😩 Quota gone, manually edit env vars to swap to another
- 😩 Some endpoint temporarily rate-limited, edit config again
- 😩 Main line recovered, no idea when to switch back
- 😩 End up babysitting several services' status just to be safe

> **I already have several working APIs — can you stop making me manage them manually every day?**

Yes. Line them up by priority, and let QuotaRouter handle the rest.

## Features

- 🎯 **Priority-based routing** — `priority: 1` is used first; on quota exhaustion it auto-switches to `2`, and so on; when a higher-priority line recovers, it preempts back immediately
- 🛡️ **Recovery confirmed by real traffic** — cooldown lapse alone doesn't count as recovery; a passive probe or real request must confirm before switching back, so it won't keep stepping back onto a broken service
- ⏳ **Hard / soft cooldown tiers** — long server-side `retry-after` locks hard cooldown (respected by pin and fallback); short rate-limits (≤60s) just wait a few seconds and retry the same backend, no wasteful switching
- 🕘 **Business-hours aware** — `businessHoursAware` backends cool down to the next window start outside hours, no idle pounding at 3am
- 🧩 **Cross-vendor body normalization** — `modelOverride` rewrites the `model` field per backend (GLM wants `GLM-5.2`, Kimi wants `k3`); empty text blocks auto-cleaned so Kimi stops 400ing
- 📊 **Live Dashboard** — token-protected, inline edit priority / pin / business hours / add-remove backends, takes effect immediately without restart
- 🔒 **Token isolation** — `config.json` gitignored, `/api/status` never exposes tokens
- 🪶 **Zero-dependency single file** — `server.js` uses only Node built-ins, `node server.js` and it's up, no `npm install`
- 🧪 **50 end-to-end tests** — real `server.js` against fake upstreams, covering every switching scenario

## How to use

**In one sentence**: an automatic transmission in front of Claude Code. If the main line works, it stays on the main line; if the main line has issues, it switches to backup automatically; when the main line recovers, it comes back automatically. Want to pin a specific service temporarily? Click it in the Dashboard — no restart needed.

## Install

```bash
git clone https://github.com/akushonkamen/QuotaRouter.git
cd QuotaRouter
cp config.example.json config.json   # fill in your backends and tokens
node server.js
```

Point Claude Code at it — `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

Done. Dashboard is at `http://127.0.0.1:8788` (stdout prints the token on first start). **From here on you never touch this address again**.

## Testing

```bash
cp server.js test/server.js
node test/run.js
```

50 assertions cover: priority routing, failover, preempt vs stick, pin, 429 cooldown, HTTP-date retry-after, empty text block cleanup, per-backend timeout, all-down returns 502, SSE streaming, backend add-remove API, config validation, token isolation, stats persistence, Dashboard auth, business-hours window.

## License

MIT

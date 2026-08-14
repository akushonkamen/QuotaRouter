<p align="center">
  <h1 align="center">QuotaRouter</h1>
  <p align="center">
    Priority-ordered failover proxy for Claude Code / Anthropic-compatible APIs.
    <br />
    <a href="./README.zh-CN.md">中文文档</a> ·
    <a href="#install">Install</a> ·
    <a href="#how-it-works">How it works</a> ·
    <a href="#why">Why</a> ·
    <a href="#config">Config</a> ·
    <a href="#run-as-a-background-service-macos">launchd</a>
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

A local proxy that sits between Claude Code and your API providers. Point Claude Code at `127.0.0.1:8787` once; QuotaRouter picks the highest-priority healthy backend, fails over on errors / rate limits, and switches back the instant a higher-priority backend recovers — confirmed by a real request, not a guess. One file, zero npm dependencies, live editable dashboard.

<!-- ![QuotaRouter dashboard](docs/dashboard.png) -->
<!-- ASCII diagram placeholder — replace with real diagram when ready -->


```
                ┌─────────────────────────── QuotaRouter (127.0.0.1:8787) ───────────────────────────┐
                │                                                                          │
   Claude Code  │  ┌── Body rewriter ──┐    ┌── Backend picker ──┐    ┌── Forwarder ──┐               │
 POST /v1/msg ──┼─▶│  modelOverride    │──▶ │  pinned? → priority│──▶│ 2xx → stream ─┼──▶ Claude Code
                │  │  stripEmptyText   │    │  skip hardCooldown │    │ 401/403 →1h  │               │
                │  └───────────────────┘    │  probe-pending fb │    │ 429≤60s→wait │               │
                │                           └────────────────────┘    │ 429>60s→f/o │               │
                │                                       │               └──────┬───────┘               │
                │                  ┌──────────────────┼──────────────────────┼────────────────────┐ │
                │                  ▼                   ▼                      ▼                    ▼ │
                │           GLM primary         custom-ip-8080          Kimi coding         GLM secondary │
                │           (P1 healthy)     (P2 hardCooldown)       (P3, k3 model)        (P4 down)    │
                └──────────────────────────────────────────────────────────────────────────────────────┘
                ▲                                                                                          │
                │            ┌──────────── Dashboard (127.0.0.1:8788) ────────────┐                      │
                └────────────│  live status · inline priority/pin/BH/add-remove │◀─────────────────────┘
                             │  token-protected · no restart on config change    │
                             └──────────────────────────────────────────────────┘
```

## Why

Most Claude API routers fall into two camps: a hosted SaaS that wants your keys, or a framework with 200 transitive deps. QuotaRouter is neither.

| | QuotaRouter | LiteLLM | Claude Code Router | One-line proxy scripts |
|---|---|---|---|---|
| **npm install needed** | ❌ none | ✅ | ✅ | varies |
| **Single file** | ✅ `server.js` | ❌ | ❌ | ✅ |
| **Live dashboard, no restart** | ✅ | ❌ | ❌ | ❌ |
| **Priority-ordered failover** | ✅ | round-robin / random | rule-based | ❌ |
| **Recovery confirmed by real traffic** | ✅ | ❌ | ❌ | ❌ |
| **Business-hours-aware cooldown** | ✅ | ❌ | ❌ | ❌ |
| **401/403 model-access classification** | ✅ | partial | ❌ | ❌ |
| **Cross-provider body normalization** | ✅ | via presets | ✅ | ❌ |

The single biggest behavioral difference: **cooldown elapse ≠ healthy**. Most routers flip a backend back to "available" the second its retry-after timer hits zero. QuotaRouter doesn't — a backend whose cooldown elapsed enters `probe-pending` and stays there until either a passive HEAD probe returns 2xx/3xx **or** a real request succeeds. A 4xx backend (expired key, revoked model access) that the passive probe can't distinguish from real health never gets to preempt a working lower-priority backend every cooldown window.

## Features

- 🎯 **Priority-ordered routing** — `priority: 1` is tried first, `2` next, and so on. Recovered higher-priority backends preempt lower ones immediately (or stay sticky if you flip `preemptOnRecovery: false`).
- 🛡️ **Recovery confirmed by real traffic** — cooldown elapse only *unlocks* a backend (`probe-pending`); a passive HEAD probe **or** a real request must confirm before it can preempt. A 4xx-dead backend never bounces back into rotation on a guess.
- ⏳ **Hard vs soft cooldowns** — server-issued long `retry-after` (429 quota-exhausted) locks the backend hard; the manual pin and the "nothing else available" fallback both respect it. Short throttles (≤60s) wait-and-retry the **same** backend instead of bouncing traffic.
- 🕘 **Business-hours-aware cooldowns** — when a failure carries no server retry-after (connection hang, plain 5xx), `businessHoursAware` backends cool down to the **next window's start** outside hours instead of hammering overnight.
- 🧩 **Cross-provider body normalization** — `modelOverride` rewrites the request body's `model` field per-backend (Claude Code always sends one local name; GLM wants `GLM-5.2`, Kimi wants `k3`). Empty text blocks (from interrupted CC turns) get stripped so Kimi doesn't 400 where GLM would accept.
- 📊 **Live dashboard** — token-protected, dark, single-page. Edit priority, preemption strategy, business hours, and the active-API pin inline; add/remove backends from the form. Changes save to `config.json` and apply immediately, **no restart**.
- 🔒 **Token isolation** — `config.json` is gitignored; `/api/status` never exposes tokens; `dashboardToken` auto-generates on first boot.
- 📈 **Stats persistence** — request/error counters survive restarts via `logs/state.json` (saved every 15s + on SIGTERM/SIGINT). App log rotates at 5MB × 3 backups.
- 🪶 **Zero dependencies, one file** — `server.js` (~1000 lines) uses only Node built-ins. `node server.js` and you're up. No `npm install`, no lockfile drift, no audit.
- 🧪 **50-assertion end-to-end suite** — `test/run.js` drives the real `server.js` against controllable fake upstreams (throttle / quota / hang / 5xx / strict / stream modes).

## Install

```bash
git clone https://github.com/akushonkamen/QuotaRouter.git
cd QuotaRouter
cp config.example.json config.json   # fill in your backends + tokens
node server.js
```

Then point Claude Code at it — in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

That's it. Dashboard lives at `http://127.0.0.1:8788` (token printed to stdout on first boot, or set `dashboardToken` explicitly in `config.json`).

## How it works

QuotaRouter runs two local HTTP servers: a **proxy** on `127.0.0.1:8787` (where Claude Code talks to) and a **dashboard** on `127.0.0.1:8788` (where you watch and steer). On every request:

1. **Body rewrite** — `prepareBodyForBackend` parses the JSON body, applies `modelOverride` (rewrites `model` to the backend's expected name) and strips empty text blocks (including nested ones inside `tool_result.content`). Non-JSON bodies pass through untouched.
2. **Backend pick** — `pickStartIndex` checks for a manual `pinnedBackend` first (skipping hard cooldowns), then walks `priorityOrder` (ascending priority) and returns the first **healthy, untried** backend. If none, it tries `probe-pending` ones as a last resort, then the soonest-recovering soft-cooldown backend.
3. **Forward** — `forwardOnce` opens the upstream request with per-backend `firstByteTimeoutMs` (for reasoning models that think before emitting the first token) and an idle timeout that resets on every chunk.
4. **Classify response**:
   - `2xx` → stream to Claude Code, mark healthy, update `currentIndex`.
   - `401/403` → read the body, classify as `auth` vs `model-access-denied`, cool down hard (1h+).
   - `429` with `retry-after ≤ 60s` → transient throttle. If the backend is pinned or no alternative exists, **wait it out and retry the same backend** (bounded by `MAX_THROTTLE_WAIT_TOTAL_MS = 45s`).
   - `429` with `retry-after > 60s` / `5xx` / timeout → `markUnhealthy` with a hard cooldown, fail over to the next backend.
5. **Loop** until one succeeds or all backends are exhausted (returns `502 all_backends_unavailable`).

Two background timers keep things honest:

- **Every `healthCheckIntervalMs`** — passive `HEAD /` probe against `probe-pending` backends. Only `2xx/3xx` marks healthy; `4xx` is **not** health (a 401/403 backend would fail every real request the same way the probe failed).
- **Every 5s** — sweep `retryAfterAt` timestamps; expired cooldowns flip from `hardCooldown` → `probe-pending`, never straight to `healthy`.

### State machine

```
        ┌──────────────────────────────────────────────────────┐
        │                                                      │
        ▼                                                      │
   ┌─────────┐  429-long / 5xx / 401-403   ┌──────────────┐   │
   │ healthy │ ──────────────────────────▶│ hardCooldown │   │
   └─────────┘                             └──────┬───────┘   │
        ▲                                          │           │
        │ 2xx confirms                             │ cooldown   │
        │ (real request OR                         │ timer (5s  │
        │  passive HEAD probe 2xx/3xx)             │ sweep)    │
        │                                          ▼           │
        │                                 ┌─────────────────┐  │
        └─────────────────────────────────│ probe-pending   │  │
                                          └────────┬────────┘  │
                                            re-fail │           │
                                            ┌───────┘           │
                                            ▼                   │
                                       back to hardCooldown ─────┘
```

> **Cooldown elapse ≠ healthy.** A backend must be confirmed by real traffic (or a 2xx/3xx passive probe) before it can preempt a working lower-priority one. This is the core difference from most failover routers — without it, a 4xx-dead backend (expired key, revoked model access) gets preferred over a working backend every cooldown window.

## Config

`config.json` (gitignored — holds live tokens). Copy `config.example.json` as a starting point.

| Key | Type | Default | Description |
|---|---|---|---|
| `proxyPort` | int | `8787` | Port the proxy listens on (point Claude Code here). |
| `dashboardPort` | int | `8788` | Port the dashboard listens on. |
| `firstByteTimeoutMs` | int | `15000` | Global time-to-first-byte budget. Per-backend `firstByteTimeoutMs` overrides this (e.g. reasoning models). |
| `idleTimeoutMs` | int | `60000` | Max gap between chunks during streaming before we give up. |
| `healthCheckIntervalMs` | int | `20000` | How often to passive-probe `probe-pending` backends. |
| `errorCooldownMs` | int | `30000` | Short cooldown when a failure gives no server retry-after. |
| `preemptOnRecovery` | bool | `true` | `true`: always use highest-priority available. `false`: sticky to current until it fails. |
| `pinnedBackend` | string\|null | `null` | Manual override — force one backend first on every request (respects hard cooldown). Dashboard-editable. |
| `businessHours` | object | — | `{ enabled, days: [0-6], startHour, endHour }`. Used for `businessHoursAware` backends when a failure gives no explicit retry-after. |
| `dashboardToken` | string\|null | auto | Auto-generates on first boot if unset. `null` or `""` disables auth. |
| `backends[]` | array | — | See below. |

### Backend fields

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique identifier shown in the dashboard. |
| `baseUrl` | ✅ | Upstream URL (e.g. `https://open.bigmodel.cn/api/anthropic`). |
| `token` | ✅ | API key for this backend. Sent as both `x-api-key` and `authorization: Bearer`. |
| `priority` | ✅ | Lower number tried first. Ties broken by config order. |
| `modelOverride` | optional | Rewrites the request body's `model` field to this value (e.g. `"k3"` for Kimi). |
| `businessHoursAware` | optional | If `true` and `businessHours.enabled`, cooldowns outside the window extend to next window start. |
| `firstByteTimeoutMs` | optional | Per-backend override of the global first-byte budget. |

Example:

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
      "baseUrl": "http://your-ip:8080",
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

## Run as a background service (macOS)

A launchd plist keeps the proxy up across reboots and crashes. Example: `~/Library/LaunchAgents/com.<user>.claude-api-proxy.plist`:

```bash
launchctl kickstart -k gui/$(id -u)/com.<user>.claude-api-proxy   # restart
launchctl bootout gui/$(id -u)/com.<user>.claude-api-proxy        # stop for good
```

State (`requests` / `errors` counters) survives restarts via `logs/state.json`.

## Testing

```bash
cp server.js test/server.js   # tests spawn test/server.js with their own config
node test/run.js
```

50 assertions covering: priority routing, failover, preemption vs sticky, pin, 429 short/long cooldowns, HTTP-date retry-after, empty-text-block normalization, per-backend timeout, 502-when-all-down, SSE streaming, backend add/remove API, config validation, token isolation, stats persistence, dashboard auth, business-hours windows.

## License

MIT

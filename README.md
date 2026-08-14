# QuotaRouter

A local proxy that sits between Claude Code and your Anthropic-compatible API providers. You throw all your coding plan endpoints at it; it picks the highest-priority healthy one, fails over on rate limits / errors, and switches back automatically when a higher-priority one recovers — confirmed by a real request, not a guess.

One file, zero npm dependencies, live editable dashboard.

<a href="./README.zh-CN.md">中文</a> · <a href="#install">Install</a> · <a href="#how-it-works">How it works</a> · <a href="#config">Config</a>

![Node](https://img.shields.io/badge/node-%3E%3D18-green) ![Dependencies](https://img.shields.io/badge/dependencies-0-blue) ![Tests](https://img.shields.io/badge/tests-50%2F50-brightgreen) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

<!-- ![QuotaRouter dashboard](docs/dashboard.png) -->
<!-- ASCII diagram placeholder — replace with real diagram when ready -->

```
                ┌─────────────────── QuotaRouter (127.0.0.1:8787) ───────────────────┐
                │                                                                    │
   Claude Code  │  ┌── Body rewrite ──┐    ┌── Pick backend ───┐    ┌── Forward ──┐  │
 POST /v1/msg ──┼─▶│  modelOverride   │──▶ │  pinned? priority │──▶│ 2xx → stream │──▶ Claude Code
                │  │  stripEmptyText  │    │  skip hardCooldown│   │ 429 → switch │  │
                │  └──────────────────┘    └───────────────────┘   └──────────────┘  │
                │                                       │                              │
                │                  ┌────────────────────┼────────────────────┐         │
                │                  ▼                    ▼                    ▼         │
                │           GLM plan #1         self-hosted IP        Kimi coding plan │
                └──────────────────────────────────────────────────────────────────────┘
                ▲                                                                              │
                │            ┌────────── Dashboard (127.0.0.1:8788) ──────────┐             │
                └────────────│  live status · inline edit · no restart        │◀────────────┘
                             └────────────────────────────────────────────────┘
```

## Install

```bash
git clone https://github.com/akushonkamen/QuotaRouter.git
cd QuotaRouter
cp config.example.json config.json   # fill in your backends + tokens
node server.js
```

Point Claude Code at it in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

Dashboard at `http://127.0.0.1:8788` (token printed to stdout on first boot).

## How it works

Two local HTTP servers: a **proxy** on `8787` (where Claude Code connects) and a **dashboard** on `8788` (where you watch and steer). On every request:

1. **Body rewrite** — apply `modelOverride` (rewrite `model` per-backend) and strip empty text blocks (Kimi rejects them, GLM accepts — normalize so all backends behave the same).
2. **Pick backend** — `pinnedBackend` first (if set, skipping hard cooldowns), then walk by ascending priority for the first healthy untried backend. If none, fall back to `probe-pending`, then soonest-recovering soft cooldown.
3. **Forward** — per-backend `firstByteTimeoutMs` (reasoning models need longer before first token) and a chunk-resetting idle timeout.
4. **Classify response**:
   - `2xx` → stream back, mark healthy.
   - `401/403` → read body, classify as `auth` vs `model-access-denied`, cool down 1h+.
   - `429` with `retry-after ≤ 60s` → transient throttle. If pinned or no alternative, wait and retry the same backend (capped at 45s total).
   - `429` with `retry-after > 60s` / `5xx` / timeout → mark hard-cooldown, fail over immediately.
5. **Loop** until one succeeds or all backends exhausted (returns `502`).

Two background timers:
- Every `healthCheckIntervalMs` — passive `HEAD /` probe on `probe-pending` backends. Only `2xx/3xx` marks healthy; `4xx` is not health.
- Every 5s — expired cooldowns flip `hardCooldown` → `probe-pending`, never straight to `healthy`.

### The key behavior: cooldown elapse ≠ healthy

A backend whose retry-after timer hits zero doesn't go straight back to "available". It enters `probe-pending` and stays there until a passive probe returns 2xx/3xx **or** a real request succeeds. Without this, a 4xx-dead backend (expired key, revoked model access) would preempt a working lower-priority backend every cooldown window.

### State machine

```
   ┌─────────┐  429-long / 5xx / 401-403   ┌──────────────┐
   │ healthy │ ──────────────────────────▶│ hardCooldown │
   └─────────┘                             └──────┬───────┘
        ▲  2xx confirms (real request OR         │ cooldown elapsed
        │  passive HEAD probe 2xx/3xx)           ▼
        │                              ┌─────────────────┐
        └──────────────────────────────│ probe-pending   │
                                       └────────┬────────┘
                                         re-fail │
                                       back to hardCooldown
```

## Config

`config.json` (gitignored — holds live tokens). Copy `config.example.json` to start.

| Key | Default | Description |
|---|---|---|
| `proxyPort` | `8787` | Proxy listen port. |
| `dashboardPort` | `8788` | Dashboard listen port. |
| `firstByteTimeoutMs` | `15000` | Global first-byte budget. Per-backend `firstByteTimeoutMs` overrides. |
| `idleTimeoutMs` | `60000` | Max gap between chunks during streaming. |
| `healthCheckIntervalMs` | `20000` | Passive-probe interval for `probe-pending` backends. |
| `errorCooldownMs` | `30000` | Short cooldown when a failure gives no server retry-after. |
| `preemptOnRecovery` | `true` | `true`: always use highest-priority available. `false`: sticky to current until it fails. |
| `pinnedBackend` | `null` | Manual override — force one backend first on every request (respects hard cooldown). Dashboard-editable. |
| `businessHours` | — | `{ enabled, days: [0-6], startHour, endHour }`. For `businessHoursAware` backends when failure gives no retry-after. |
| `dashboardToken` | auto | Auto-generates on first boot. `null`/`""` disables auth. |

### Backend fields

| Field | Required | Description |
|---|---|---|
| `name` | ✅ | Unique identifier. |
| `baseUrl` | ✅ | Upstream URL. |
| `token` | ✅ | API key. Sent as both `x-api-key` and `authorization: Bearer`. |
| `priority` | ✅ | Lower number tried first. |
| `modelOverride` | optional | Rewrites request body `model` field (e.g. `"k3"` for Kimi). |
| `businessHoursAware` | optional | Cooldowns outside business hours extend to next window start. |
| `firstByteTimeoutMs` | optional | Per-backend override of the global first-byte budget. |

```json
{
  "backends": [
    { "name": "glm-primary", "baseUrl": "https://open.bigmodel.cn/api/anthropic", "token": "sk-...", "priority": 1 },
    { "name": "custom-ip", "baseUrl": "http://your-ip:8080", "token": "sk-...", "priority": 2, "businessHoursAware": true, "modelOverride": "GLM-5.2" },
    { "name": "kimi-coding", "baseUrl": "https://api.kimi.com/coding", "token": "sk-...", "priority": 3, "modelOverride": "k3", "firstByteTimeoutMs": 120000 }
  ]
}
```

## Run as a background service (macOS)

launchd plist keeps the proxy up across reboots and crashes:

```bash
launchctl kickstart -k gui/$(id -u)/com.<user>.claude-api-proxy   # restart
launchctl bootout gui/$(id -u)/com.<user>.claude-api-proxy        # stop
```

State (`requests` / `errors` counters) survives restarts via `logs/state.json`.

## Testing

```bash
cp server.js test/server.js
node test/run.js
```

50 assertions covering: priority routing, failover, preemption vs sticky, pin, 429 cooldowns, HTTP-date retry-after, empty-text-block normalization, per-backend timeout, 502-when-all-down, SSE streaming, backend add/remove API, config validation, token isolation, stats persistence, dashboard auth, business-hours windows.

## License

MIT

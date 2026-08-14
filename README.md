# QuotaRouter

A local failover proxy for Claude Code / Anthropic-compatible API backends.
Claude Code points at this proxy instead of a single API provider; the proxy
picks the highest-priority healthy backend, fails over on errors/rate limits,
and switches back the instant a higher-priority backend recovers.

## Run

```bash
node server.js
```

Dashboard: http://127.0.0.1:8788 (editable priority, preemption strategy, and
business hours — changes apply live, no restart).

Point Claude Code at it by setting in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-managed"
  }
}
```

## Config

Copy `config.example.json` to `config.json` and fill in real backends —
`config.json` holds live tokens and is gitignored.

- `backends[].priority` — lower number tried first. Recovers preemptively:
  if `preemptOnRecovery` is true (default), a higher-priority backend that
  comes back online is used again immediately, even mid-outage of a lower one.
- `businessHours` — when a failure gives no explicit reactivation time (e.g. a
  connection hang, not a `429` with `retry-after`), the proxy assumes the
  backend is only expected to be up within this window and skips retrying it
  outside those hours. Editable from the dashboard.

## Running as a background service (macOS launchd)

See `~/Library/LaunchAgents/com.yp1017.claude-api-proxy.plist` — points at
this directory, restarts on crash, starts on login.

```bash
launchctl kickstart -k gui/$(id -u)/com.yp1017.claude-api-proxy   # restart
launchctl bootout gui/$(id -u)/com.yp1017.claude-api-proxy        # stop for good
```

'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// undefined = never configured, auto-generate one; null/"" = auth explicitly disabled, leave it
if (config.dashboardToken === undefined) {
  config.dashboardToken = crypto.randomBytes(16).toString('hex');
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  onDisk.dashboardToken = config.dashboardToken;
  fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + '\n');
}

const backends = config.backends.map((b, i) => ({
  ...b,
  priority: b.priority != null ? b.priority : i + 1, // lower number = tried first
  healthy: true,
  requests: 0,
  errors: 0,
  lastLatencyMs: null,
  lastError: null,
  lastSwitchAt: null,
  lastUsedAt: null,
  retryAfterAt: null, // ISO timestamp when a rate-limit cooldown ends, or null
  hardCooldown: false, // true when retryAfterAt came from a real server retry-after
}));

// indices sorted by ascending priority (highest priority first), ties broken by config order
let priorityOrder = [];
function recomputePriorityOrder() {
  priorityOrder = backends
    .map((_, idx) => idx)
    .sort((a, b) => backends[a].priority - backends[b].priority || a - b);
}
recomputePriorityOrder();

const STATE_PATH = path.join(__dirname, 'logs', 'state.json');
function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    (saved.backends || []).forEach((s) => {
      const b = backends.find((x) => x.name === s.name);
      if (b) {
        b.requests = s.requests || 0;
        b.errors = s.errors || 0;
      }
    });
  } catch {
    // no prior state on disk yet, start from zero
  }
}
loadState();

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({
      savedAt: new Date().toISOString(),
      backends: backends.map((b) => ({ name: b.name, requests: b.requests, errors: b.errors })),
    }, null, 2));
  } catch {
    // best-effort; losing cumulative counters on a crash is acceptable
  }
}
setInterval(saveState, 15000);
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT', () => { saveState(); process.exit(0); });

function persistConfig() {
  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  onDisk.preemptOnRecovery = config.preemptOnRecovery !== false;
  onDisk.businessHours = config.businessHours;
  onDisk.pinnedBackend = config.pinnedBackend || null;
  // `backends` (live, in-memory) is the source of truth from here on, so add/remove
  // operations just work — persist only the config-shaped fields, not runtime state.
  onDisk.backends = backends.map((b) => {
    const persisted = { name: b.name, baseUrl: b.baseUrl, token: b.token, priority: b.priority };
    if (b.businessHoursAware) persisted.businessHoursAware = true;
    if (b.modelOverride) persisted.modelOverride = b.modelOverride;
    if (b.firstByteTimeoutMs != null) persisted.firstByteTimeoutMs = b.firstByteTimeoutMs;
    return persisted;
  });
  fs.writeFileSync(configPath, JSON.stringify(onDisk, null, 2) + '\n');
}

let currentIndex = 0;
const events = []; // ring buffer of recent events
const MAX_EVENTS = 100;

const LOG_DIR = path.join(__dirname, 'logs');
const APP_LOG = path.join(LOG_DIR, 'app.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_BACKUPS = 3;

function rotateLogIfNeeded() {
  let size = 0;
  try {
    size = fs.statSync(APP_LOG).size;
  } catch {
    return;
  }
  if (size < MAX_LOG_BYTES) return;
  for (let i = MAX_LOG_BACKUPS; i >= 1; i--) {
    const src = i === 1 ? APP_LOG : `${APP_LOG}.${i - 1}`;
    const dst = `${APP_LOG}.${i}`;
    try {
      fs.renameSync(src, dst);
    } catch {
      // no such backup yet, nothing to rotate at this slot
    }
  }
}

function writeLog(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateLogIfNeeded();
    fs.appendFileSync(APP_LOG, line + '\n');
  } catch {
    // logging must never crash the proxy itself
  }
}

function logEvent(type, detail) {
  events.unshift({ ts: new Date().toISOString(), type, detail });
  if (events.length > MAX_EVENTS) events.pop();
  writeLog(`[${new Date().toISOString()}] ${type}: ${detail}`);
}

function isAvailable(b) {
  if (b.retryAfterAt && Date.now() >= new Date(b.retryAfterAt).getTime()) {
    // Cooldown elapsed: clear the lock, but DON'T flip to healthy on a guess.
    // A recovered backend must be re-confirmed by a successful real request
    // before it can preempt a healthy lower-priority one — otherwise a 4xx
    // backend (e.g. an expired key) that the passive HEAD probe can't tell
    // from real health would get preferred over a working backend every
    // cooldown window. probe-pending (isProbePending) makes it retryable as a
    // last resort in pickAvailableIndex's second pass instead.
    b.retryAfterAt = null;
    b.hardCooldown = false;
  }
  return b.healthy;
}

// A backend whose cooldown has elapsed but hasn't yet been confirmed healthy
// by a successful real request. It's not "available" (don't prefer it), but
// it's retryable as a last resort — unlike a hard-cooldown backend which must
// be respected.
function isProbePending(b) {
  return !b.healthy && !b.retryAfterAt && !b.hardCooldown;
}

// Always prefer the highest-priority available backend, skipping ones already
// tried in this request. This makes a recovered higher-priority backend get
// used again immediately on the very next request, instead of sticking with
// whatever lower-priority backend the previous request fell back to.
function pickAvailableIndex(triedSet) {
  for (const idx of priorityOrder) {
    if (triedSet.has(idx)) continue;
    if (isAvailable(backends[idx])) return idx;
  }
  // No healthy untried backend. As a last resort, try one whose cooldown has
  // elapsed but hasn't been re-confirmed yet (probe-pending) — prefer in
  // priority order. This lets a real request validate recovery instead of the
  // caller failing when traffic is the only honest probe. Hard cooldowns are
  // still respected: never retry one early.
  for (const idx of priorityOrder) {
    if (triedSet.has(idx)) continue;
    const b = backends[idx];
    if (b.hardCooldown) continue;
    if (isProbePending(b)) return idx;
  }
  // Otherwise retry whichever untried soft-cooldown backend recovers soonest.
  let bestIdx = null;
  let bestAt = Infinity;
  for (const idx of priorityOrder) {
    if (triedSet.has(idx)) continue;
    if (backends[idx].hardCooldown) continue;
    const at = backends[idx].retryAfterAt ? new Date(backends[idx].retryAfterAt).getTime() : Infinity;
    if (at < bestAt) {
      bestAt = at;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

// Preemption strategy, user-editable in config.json:
//   "preemptOnRecovery": true  -> always use the highest-priority available backend,
//                                  switching back the instant a higher one recovers (default)
//   "preemptOnRecovery": false -> sticky: keep using the current backend until it fails,
//                                  only falling back to priority order at that point
//
// "pinnedBackend": manual override from the dashboard. Forced first on every new
// request even if it's down or on a soft (guessed) cooldown — the user explicitly
// asked for this one, and if it fails the request still fails over through normal
// priority order rather than hard-erroring. It does NOT override a hard cooldown
// (a real server-issued retry-after, e.g. a 429): retrying an active rate limit
// on purpose just earns another 429 and can make the account-level limit worse.
function pickStartIndex(triedSet) {
  if (config.pinnedBackend) {
    const idx = backends.findIndex((b) => b.name === config.pinnedBackend);
    if (idx !== -1 && !triedSet.has(idx) && !backends[idx].hardCooldown) return idx;
  }
  if (config.preemptOnRecovery === false) {
    if (!triedSet.has(currentIndex) && isAvailable(backends[currentIndex])) return currentIndex;
  }
  return pickAvailableIndex(triedSet);
}

// A server-provided retry-after at or below this is treated as transient
// throttling: wait it out and retry the same backend rather than failing over.
const SHORT_COOLDOWN_MAX_SECONDS = 60;
// Total time a single request may spend waiting out throttles before it gives
// up and fails over, so a provider that keeps saying "retry in 60s" can't stall
// the caller indefinitely.
const MAX_THROTTLE_WAIT_TOTAL_MS = 45000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// When a failure carries no server-provided retry-after (connection hang, plain
// 5xx), we don't know the real reactivation time. If business hours are enabled,
// assume the backend is only expected to work inside that window: a short retry
// while we're inside it, or a wait straight through to the next window's start
// if we're outside it (so we stop hammering it overnight/weekends for nothing).
function unknownCooldownSeconds(now, backend) {
  const bh = config.businessHours;
  const shortRetry = (config.errorCooldownMs || 30000) / 1000;
  if (!bh || !bh.enabled || !backend.businessHoursAware) return shortRetry;

  const days = bh.days && bh.days.length ? bh.days : [1, 2, 3, 4, 5];
  const startHour = bh.startHour != null ? bh.startHour : 9;
  const endHour = bh.endHour != null ? bh.endHour : 21;
  const hourNow = now.getHours() + now.getMinutes() / 60;

  if (days.includes(now.getDay()) && hourNow >= startHour && hourNow < endHour) {
    return shortRetry;
  }

  for (let addDays = 0; addDays <= 8; addDays++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + addDays);
    candidate.setHours(startHour, 0, 0, 0);
    if (candidate > now && days.includes(candidate.getDay())) {
      return Math.max(1, Math.round((candidate.getTime() - now.getTime()) / 1000));
    }
  }
  return shortRetry;
}

function markUnhealthy(idx, reason, retryAfterSeconds) {
  const b = backends[idx];
  if (b.healthy) {
    b.healthy = false;
    b.lastSwitchAt = new Date().toISOString();
  }
  b.errors++;
  b.lastError = reason;
  // Every failure gets a cooldown, even ones with no server-provided retry-after
  // (e.g. a connection hang from an IP-restricted host), so a single request
  // never re-pays the same slow timeout on every subsequent call.
  const seconds = retryAfterSeconds != null ? retryAfterSeconds : unknownCooldownSeconds(new Date(), b);
  const at = new Date(Date.now() + seconds * 1000).toISOString();
  b.retryAfterAt = at;
  // Providers use 429 for two very different things: a short retry-after (a few
  // seconds) is transient throttling — "you're sending too fast" — while a long
  // one means the quota/rate window is actually exhausted. Only the long kind is
  // an authoritative lockout that the "nothing else available" fallback and the
  // manual pin must respect; treating a 5-second throttle as a lockout would
  // bounce traffic onto other backends (and away from a pinned one) needlessly.
  b.hardCooldown = retryAfterSeconds != null && retryAfterSeconds > SHORT_COOLDOWN_MAX_SECONDS;
  logEvent('backend-down', `${b.name} unhealthy: ${reason}, retry in ${seconds}s (until ${at})`);
}

function markHealthyByRef(b) {
  b.healthy = true;
  b.retryAfterAt = null;
  b.hardCooldown = false;
  logEvent('backend-up', `${b.name} recovered`);
}

function markHealthy(idx) {
  const b = backends[idx];
  if (!b.healthy) markHealthyByRef(b);
}

const FAILOVER_STATUS = new Set([401, 403, 429, 500, 502, 503, 504]);

// Retry-After is either delay-seconds ("120") or an HTTP-date
// ("Fri, 07 Aug 2026 04:52:33 GMT") per RFC 7231 7.1.3.
function parseRetryAfter(header) {
  if (header == null) return null;
  const asSeconds = Number(header);
  if (!isNaN(asSeconds)) return asSeconds;
  const asDate = Date.parse(header);
  if (!isNaN(asDate)) return Math.max(0, Math.round((asDate - Date.now()) / 1000));
  return null;
}

// Claude Code sends whatever ANTHROPIC_DEFAULT_*_MODEL is configured locally
// (one fixed name for every backend) as the request body's "model" field.
// Backends with a different model naming scheme (e.g. Kimi's "k3" vs our
// local "glm-5.2") need that field rewritten before forwarding, or the
// backend rejects the request as an unrecognized model.
// Providers disagree on empty text blocks: Kimi rejects them outright with
// "text content is empty", while GLM accepts them. Clients legitimately produce
// them — e.g. Claude Code recording a turn that was interrupted mid-stream — so
// the same conversation would work on one backend and 400 on another. Empty text
// carries no information, so strip it and make every backend behave the same.
function stripEmptyTextBlocks(payload) {
  let changed = false;
  const isEmptyText = (b) =>
    b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() === '';

  const clean = (blocks) => {
    const kept = [];
    let removed = false;
    for (const b of blocks) {
      if (isEmptyText(b)) { removed = true; changed = true; continue; }
      // tool_result blocks carry their own nested content array — a tool that
      // produced no output lands here, which is exactly the common case.
      if (b && Array.isArray(b.content)) b.content = clean(b.content);
      kept.push(b);
    }
    // Never leave a message with no content: that is invalid everywhere, and
    // dropping the message outright would break user/assistant alternation.
    if (!kept.length && removed) return [{ type: 'text', text: ' ' }];
    return kept;
  };

  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages) {
      if (msg && Array.isArray(msg.content)) msg.content = clean(msg.content);
    }
  }
  if (Array.isArray(payload.system)) payload.system = clean(payload.system);
  return changed;
}

// Claude Code sends whatever ANTHROPIC_DEFAULT_*_MODEL is configured locally
// (one fixed name for every backend) as the request body's "model" field.
// Backends with a different model naming scheme (e.g. Kimi's "k3" vs our
// local "glm-5.2") need that field rewritten before forwarding, or the
// backend rejects the request as an unrecognized model.
function prepareBodyForBackend(backend, bodyBuffer) {
  if (!bodyBuffer || !bodyBuffer.length) return bodyBuffer;
  let parsed;
  try {
    parsed = JSON.parse(bodyBuffer.toString('utf8'));
  } catch {
    return bodyBuffer; // not a JSON body (e.g. GET with no body) — leave untouched
  }
  if (typeof parsed !== 'object' || parsed === null) return bodyBuffer;

  let changed = false;
  if (backend.modelOverride && 'model' in parsed) {
    parsed.model = backend.modelOverride;
    changed = true;
  }
  if (stripEmptyTextBlocks(parsed)) changed = true;
  return changed ? Buffer.from(JSON.stringify(parsed), 'utf8') : bodyBuffer;
}

function forwardOnce(backend, req, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const target = new URL(backend.baseUrl.replace(/\/+$/, '') + req.url);
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const effectiveBody = prepareBodyForBackend(backend, bodyBuffer);

    const headers = { ...req.headers };
    delete headers.host;
    delete headers['content-length'];
    headers['x-api-key'] = backend.token;
    headers['authorization'] = `Bearer ${backend.token}`;

    const options = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    };

    const start = Date.now();
    // Reasoning models (e.g. Kimi's k3) think before emitting the first token,
    // so time-to-first-byte can far exceed what a normal backend needs. Let a
    // backend override the global budget rather than being failed over every time.
    const firstByteTimeoutMs = backend.firstByteTimeoutMs != null
      ? backend.firstByteTimeoutMs
      : config.firstByteTimeoutMs;
    let firstByteTimer = setTimeout(() => {
      upstreamReq.destroy(new Error('first-byte-timeout'));
    }, firstByteTimeoutMs);

    const upstreamReq = lib.request(options, (upstreamRes) => {
      clearTimeout(firstByteTimer);
      const latency = Date.now() - start;
      resolve({ upstreamRes, latency });
    });

    upstreamReq.on('error', (err) => {
      clearTimeout(firstByteTimer);
      reject(err);
    });

    if (effectiveBody && effectiveBody.length) upstreamReq.write(effectiveBody);
    upstreamReq.end();
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Drain an upstream response body into a string so we can classify 4xx errors
// (auth-403 vs model-access-403). Bounded by a small cap so a huge error page
// can't stall failover.
function readUpstreamBody(upstreamRes, cap = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    upstreamRes.on('data', (c) => {
      size += c.length;
      if (size <= cap) chunks.push(c);
    });
    upstreamRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    upstreamRes.on('error', reject);
  });
}

async function handleProxyRequest(req, res) {
  const bodyBuffer = await readBody(req).catch(() => Buffer.alloc(0));
  const tried = new Set();
  let lastErr = null;
  let throttleWaits = 0;

  while (tried.size < backends.length) {
    const idx = pickStartIndex(tried);
    if (idx == null) break;
    tried.add(idx);
    const backend = backends[idx];
    backend.requests++;
    backend.lastUsedAt = new Date().toISOString();
    try {
      const { upstreamRes, latency } = await forwardOnce(backend, req, bodyBuffer);

      if (FAILOVER_STATUS.has(upstreamRes.statusCode)) {
        const retryAfterSeconds = parseRetryAfter(upstreamRes.headers['retry-after']);
        // 401/403 are not transient — they're key expiry or model-access
        // denials. Retrying in 30s just re-logs the same error and inflates
        // the error counter; read the body to tell auth-403 from
        // model-access-403, then cool down hard.
        let reason = `HTTP ${upstreamRes.statusCode}`;
        let cooldown = retryAfterSeconds;
        if (upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403) {
          const bodyText = await readUpstreamBody(upstreamRes).catch(() => '');
          upstreamRes.resume();
          const lower = bodyText.toLowerCase();
          const isModelAccess = lower.includes('model') && (
            lower.includes('not allowed') || lower.includes('access') ||
            lower.includes('denied') || lower.includes('permission'));
          reason = isModelAccess
            ? `HTTP ${upstreamRes.statusCode} (model-access-denied)`
            : `HTTP ${upstreamRes.statusCode} (auth)`;
          // Model-access denial won't change in 30s — cool it to next business
          // window (or 1h if no business hours). Plain auth (bad/expired key)
          // gets the same long cool: the user has to fix the key, not us.
          cooldown = unknownCooldownSeconds(new Date(), backend);
          if (!cooldown || cooldown * 1000 < 60 * 60 * 1000) {
            cooldown = 60 * 60; // 1h floor when business-hours math gives short
          }
        } else {
          upstreamRes.resume(); // drain
        }
        markUnhealthy(idx, reason, cooldown);


        // Transient throttle ("slow down", a few seconds) rather than an
        // exhausted quota. Failing over is pointless when the user pinned this
        // backend, or when nothing else is left to try — wait it out and retry
        // the same one instead of abandoning it or erroring the request.
        const isShortThrottle = retryAfterSeconds != null &&
          retryAfterSeconds <= SHORT_COOLDOWN_MAX_SECONDS;
        const noAlternative = pickAvailableIndex(tried) == null;
        const waitMs = retryAfterSeconds * 1000;
        if (isShortThrottle && throttleWaits + waitMs <= MAX_THROTTLE_WAIT_TOTAL_MS &&
            (config.pinnedBackend === backend.name || noAlternative)) {
          throttleWaits += waitMs;
          logEvent('backend-throttled',
            `${backend.name} throttled ${retryAfterSeconds}s, waiting to retry same backend`);
          await sleep(waitMs);
          // A concurrent request may have hit a real quota wall on this backend
          // while we slept; that lockout is authoritative, so don't wipe it.
          if (!backend.hardCooldown) {
            backend.healthy = true;
            backend.retryAfterAt = null;
          }
          tried.delete(idx);
          continue;
        }
        continue;
      }

      markHealthy(idx);
      backend.lastLatencyMs = latency;
      currentIndex = idx;

      res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      let idleTimer = setTimeout(() => {
        upstreamRes.destroy(new Error('idle-timeout'));
      }, config.idleTimeoutMs);
      upstreamRes.on('data', (chunk) => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          upstreamRes.destroy(new Error('idle-timeout'));
        }, config.idleTimeoutMs);
        res.write(chunk);
      });
      upstreamRes.on('end', () => {
        clearTimeout(idleTimer);
        res.end();
      });
      upstreamRes.on('error', () => {
        clearTimeout(idleTimer);
        res.end();
      });
      return;
    } catch (err) {
      lastErr = err;
      markUnhealthy(idx, err.message);
    }
  }

  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'all_backends_unavailable', lastError: lastErr && lastErr.message }));
}

const proxyServer = http.createServer((req, res) => {
  handleProxyRequest(req, res).catch((err) => {
    logEvent('proxy-error', err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

proxyServer.listen(config.proxyPort, '127.0.0.1', () => {
  logEvent('startup', `proxy listening on 127.0.0.1:${config.proxyPort}`);
});

// --- passive health check for downed backends without a known retry-after ---
setInterval(() => {
  backends.forEach((b, idx) => {
    if (b.healthy) return;
    if (b.retryAfterAt) return; // known cooldown: wait it out instead of hammering with probes
    const target = new URL(b.baseUrl);
    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      { hostname: target.hostname, port: target.port || (isHttps ? 443 : 80), path: '/', method: 'HEAD', timeout: 5000 },
      (r) => {
        r.resume();
        // 4xx (auth/quota/model-access) is NOT health. A 401/403 backend will
        // fail every real request the same way it failed the probe; marking it
        // healthy here just triggers the 30s bounce loop again on the next call.
        // Treat 2xx/3xx as recovered; leave 4xx/5xx to their existing cooldown.
        if (r.statusCode && r.statusCode < 400) markHealthy(idx);
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end();
  });
}, config.healthCheckIntervalMs);

// proactively flip backends back to healthy once their retry-after cooldown elapses,
// so the dashboard reflects recovery even with no live traffic
setInterval(() => {
  backends.forEach((b) => isAvailable(b));
}, 5000);

// --- dashboard server ---
const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Claude API Proxy</title>
<style>
body{font-family:-apple-system,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:24px}
h1{font-size:18px;margin-bottom:16px}
table{border-collapse:collapse;width:100%;margin-bottom:24px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #21262d;font-size:13px}
th{color:#8b949e;font-weight:600}
.healthy{color:#3fb950}
.unhealthy{color:#f85149}
.current{background:#132030}
#events{font-size:12px;font-family:ui-monospace,monospace;max-height:300px;overflow:auto;background:#161b22;padding:12px;border-radius:6px}
.event-down{color:#f85149}
.event-up{color:#3fb950}
.event-startup{color:#58a6ff}
.priority-input{width:48px;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 6px;font-size:13px}
select#preemptSelect{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:13px}
#controls{display:flex;align-items:center;gap:10px;margin:-8px 0 8px;font-size:13px;color:#8b949e}
#bhControls{display:flex;align-items:center;gap:14px;margin:0 0 12px;font-size:13px;color:#8b949e;flex-wrap:wrap}
#bhDays label{margin-right:6px;font-size:12px}
#saveStatus{color:#3fb950}
select#pinSelect{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:13px}
.text-input{background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:5px 8px;font-size:13px;margin-right:6px}
#addForm{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:16px}
#addForm button{background:#238636;color:#fff;border:none;border-radius:4px;padding:6px 14px;font-size:13px;cursor:pointer}
#addStatus{color:#3fb950;font-size:12px}
.remove-btn{background:none;border:1px solid #f85149;color:#f85149;border-radius:4px;padding:2px 8px;font-size:12px;cursor:pointer}
</style></head>
<body>
<h1>Claude API Proxy Status</h1>
<div id="controls">
  <label>Active API:
    <select id="pinSelect"></select>
  </label>
  <label>Preemption strategy:
    <select id="preemptSelect">
      <option value="true">Preemptive (always use highest-priority available)</option>
      <option value="false">Sticky (stay on current until it fails)</option>
    </select>
  </label>
  <span id="saveStatus"></span>
</div>
<div id="bhControls">
  <label><input type="checkbox" id="bhEnabled"/> Business hours (used when a failure gives no explicit retry time)</label>
  <label>Days: <span id="bhDays"></span></label>
  <label>Start <input type="number" id="bhStart" class="priority-input" min="0" max="23" style="width:44px"/></label>
  <label>End <input type="number" id="bhEnd" class="priority-input" min="1" max="24" style="width:44px"/></label>
</div>
<p style="font-size:12px;color:#8b949e;margin:-8px 0 16px">Priority, preemption, business hours, and the active-API pin are all editable inline — changes save automatically and apply immediately, no restart needed.</p>
<table id="backends"></table>

<h2 style="font-size:14px">Add Backend</h2>
<form id="addForm">
  <input class="text-input" id="newName" placeholder="name" required/>
  <input class="text-input" id="newBaseUrl" placeholder="https://api.example.com/anthropic" required style="width:260px"/>
  <input class="text-input" id="newToken" placeholder="token" type="password" required style="width:180px"/>
  <input class="text-input" id="newPriority" type="number" placeholder="priority (auto)" style="width:110px"/>
  <input class="text-input" id="newModelOverride" placeholder="model override (optional)" style="width:150px"/>
  <label style="font-size:12px"><input type="checkbox" id="newBusinessHoursAware"/> business-hours-aware</label>
  <button type="submit">Add</button>
  <span id="addStatus"></span>
</form>

<h2 style="font-size:14px">Recent Events</h2>
<div id="events"></div>
<script>
function fmtCountdown(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m || h) parts.push(m + 'm');
  parts.push(sec + 's');
  return parts.join(' ') + ' (' + new Date(iso).toLocaleTimeString() + ')';
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
document.getElementById('bhDays').innerHTML = DAY_NAMES.map((name, i) =>
  \`<label><input type="checkbox" class="bh-input bh-day" data-day="\${i}"/> \${name}</label>\`).join('');

function isTrackedControl(el) {
  if (!el || !el.classList) return false;
  return el.classList.contains('priority-input') || el.classList.contains('bh-input') ||
    el.id === 'preemptSelect' || el.id === 'pinSelect';
}

let editing = false;
document.addEventListener('focusin', (e) => { if (isTrackedControl(e.target)) editing = true; });
document.addEventListener('focusout', (e) => {
  if (isTrackedControl(e.target)) setTimeout(() => { editing = false; }, 400);
});
document.addEventListener('change', (e) => {
  // checkboxes don't reliably fire focusin in every browser path; treat any
  // change on a tracked control as a brief editing window too.
  if (isTrackedControl(e.target)) {
    editing = true;
    setTimeout(() => { editing = false; }, 400);
  }
});

async function saveConfig(partial) {
  const status = document.getElementById('saveStatus');
  status.style.color = '#3fb950';
  status.textContent = 'Saving...';
  try {
    const r = await fetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(partial),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'unknown error');
    status.textContent = 'Saved';
  } catch (err) {
    status.style.color = '#f85149';
    status.textContent = 'Error: ' + err.message;
  }
  setTimeout(() => { status.textContent = ''; }, 2000);
  refresh();
}

function attachPriorityListeners() {
  document.querySelectorAll('.backend-priority-input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const priorities = Array.from(document.querySelectorAll('.backend-priority-input'))
        .map((el) => ({ name: el.dataset.name, priority: Number(el.value) }));
      saveConfig({ priorities });
    });
  });
}

document.getElementById('preemptSelect').addEventListener('change', (e) => {
  saveConfig({ preemptOnRecovery: e.target.value === 'true' });
});

document.getElementById('pinSelect').addEventListener('change', (e) => {
  saveConfig({ pinnedBackend: e.target.value || null });
});

function attachRemoveListeners() {
  document.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (!confirm('Remove backend "' + name + '"?')) return;
      const status = document.getElementById('saveStatus');
      try {
        const r = await fetch('/api/backends/remove', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'unknown error');
        status.style.color = '#3fb950';
        status.textContent = 'Removed ' + name;
      } catch (err) {
        status.style.color = '#f85149';
        status.textContent = 'Error: ' + err.message;
      }
      setTimeout(() => { status.textContent = ''; }, 2000);
      refresh();
    });
  });
}

document.getElementById('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = document.getElementById('addStatus');
  status.style.color = '#3fb950';
  status.textContent = 'Adding...';
  const payload = {
    name: document.getElementById('newName').value.trim(),
    baseUrl: document.getElementById('newBaseUrl').value.trim(),
    token: document.getElementById('newToken').value.trim(),
    priority: document.getElementById('newPriority').value,
    modelOverride: document.getElementById('newModelOverride').value.trim(),
    businessHoursAware: document.getElementById('newBusinessHoursAware').checked,
  };
  try {
    const r = await fetch('/api/backends', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!d.ok) throw new Error(d.error || 'unknown error');
    status.textContent = 'Added ' + payload.name;
    document.getElementById('addForm').reset();
  } catch (err) {
    status.style.color = '#f85149';
    status.textContent = 'Error: ' + err.message;
  }
  setTimeout(() => { status.textContent = ''; }, 3000);
  refresh();
});

function saveBusinessHours() {
  const days = Array.from(document.querySelectorAll('.bh-day'))
    .filter((cb) => cb.checked)
    .map((cb) => Number(cb.dataset.day));
  saveConfig({
    businessHours: {
      enabled: document.getElementById('bhEnabled').checked,
      days,
      startHour: Number(document.getElementById('bhStart').value),
      endHour: Number(document.getElementById('bhEnd').value),
    },
  });
}
document.getElementById('bhEnabled').addEventListener('change', saveBusinessHours);
document.getElementById('bhStart').addEventListener('change', saveBusinessHours);
document.getElementById('bhEnd').addEventListener('change', saveBusinessHours);
document.getElementById('bhDays').addEventListener('change', (e) => {
  if (e.target.classList.contains('bh-day')) saveBusinessHours();
});

async function refresh() {
  const r = await fetch('/api/status');
  const d = await r.json();

  const preemptSelect = document.getElementById('preemptSelect');
  if (!editing) {
    preemptSelect.value = String(d.preemptOnRecovery !== false);
  }

  const pinSelect = document.getElementById('pinSelect');
  if (!editing) {
    pinSelect.innerHTML = '<option value="">Auto (priority-based)</option>' +
      d.backends.map((b) => \`<option value="\${b.name}">\${b.name}</option>\`).join('');
    pinSelect.value = d.pinnedBackend || '';
  }

  if (!editing && d.businessHours) {
    document.getElementById('bhEnabled').checked = d.businessHours.enabled !== false;
    document.getElementById('bhStart').value = d.businessHours.startHour;
    document.getElementById('bhEnd').value = d.businessHours.endHour;
    const activeDays = new Set(d.businessHours.days || []);
    document.querySelectorAll('.bh-day').forEach((cb) => {
      cb.checked = activeDays.has(Number(cb.dataset.day));
    });
  }

  if (!editing) {
    const sorted = [...d.backends].map((b, i) => ({ ...b, origIndex: i })).sort((a, b) => a.priority - b.priority);
    const rows = sorted.map((b) => \`
      <tr class="\${b.origIndex === d.currentIndex ? 'current' : ''}">
        <td>\${b.origIndex === d.currentIndex ? '&#9654; ' : ''}<input class="priority-input backend-priority-input" type="number" data-name="\${b.name}" value="\${b.priority}"/></td>
        <td>\${b.name}\${b.name === d.pinnedBackend ? ' &#128204;' : ''}</td>
        <td>\${b.baseUrl}</td>
        <td>\${b.modelOverride || '(default)'}</td>
        <td class="\${b.healthy ? 'healthy' : 'unhealthy'}">\${b.healthy ? 'healthy' : 'DOWN'}</td>
        <td>\${b.requests}</td>
        <td>\${b.errors}</td>
        <td>\${b.lastLatencyMs != null ? b.lastLatencyMs + 'ms' : '-'}</td>
        <td>\${b.lastError || '-'}</td>
        <td>\${fmtCountdown(b.retryAfterAt)}\${b.retryAfterAt && b.hardCooldown ? ' <span title="server-issued retry-after, respected exactly">&#128274;</span>' : ''}</td>
        <td><button class="remove-btn" data-name="\${b.name}">Remove</button></td>
      </tr>\`).join('');
    document.getElementById('backends').innerHTML =
      '<tr><th>Priority</th><th>Backend</th><th>Base URL</th><th>Model</th><th>Status</th><th>Requests</th><th>Errors</th><th>Latency</th><th>Last Error</th><th>Reactivates In</th><th></th></tr>' + rows;
    attachPriorityListeners();
    attachRemoveListeners();
  }

  document.getElementById('events').innerHTML = d.events.map(e =>
    \`<div class="event-\${e.type.split('-')[1] || e.type}">[\${e.ts}] \${e.type}: \${e.detail}</div>\`).join('');
}
refresh();
setInterval(refresh, 2000);
</script>
</body></html>`;

function redactBackends() {
  return backends.map(({ token, ...rest }) => rest);
}

function checkDashboardAuth(req, query) {
  const token = config.dashboardToken;
  if (!token) return true;
  if (query.get('token') === token) return true;
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)dt=([^;]+)/);
  if (match && match[1] === token) return true;
  if (req.headers['x-dashboard-token'] === token) return true;
  return false;
}

const dashboardServer = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  if (!checkDashboardAuth(req, reqUrl.searchParams)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end(`Unauthorized. Open http://127.0.0.1:${config.dashboardPort}/?token=<your-token> once (token is in config.json) to set a session cookie.`);
    return;
  }

  if (req.url.startsWith('/api/status')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      currentIndex,
      preemptOnRecovery: config.preemptOnRecovery !== false,
      pinnedBackend: config.pinnedBackend || null,
      businessHours: config.businessHours,
      backends: redactBackends(),
      events,
    }));
    return;
  }

  if (req.url === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const update = JSON.parse(body || '{}');
        if (Array.isArray(update.priorities)) {
          // Resolve and validate every entry before touching any of them: a
          // rejected request must not leave half the priorities applied.
          const resolved = update.priorities.map((entry) => {
            const b = backends.find((x) => x.name === entry.name);
            if (!b) throw new Error(`unknown backend: ${entry.name}`);
            const priority = Number(entry.priority);
            if (!Number.isFinite(priority)) throw new Error(`invalid priority for ${entry.name}`);
            return { backend: b, priority };
          });
          for (const { backend, priority } of resolved) backend.priority = priority;
          recomputePriorityOrder();
        }
        if (typeof update.preemptOnRecovery === 'boolean') {
          config.preemptOnRecovery = update.preemptOnRecovery;
        }
        if ('pinnedBackend' in update) {
          if (update.pinnedBackend === null || update.pinnedBackend === '') {
            config.pinnedBackend = null;
          } else if (backends.some((b) => b.name === update.pinnedBackend)) {
            config.pinnedBackend = update.pinnedBackend;
          } else {
            throw new Error(`unknown backend: ${update.pinnedBackend}`);
          }
        }
        if (update.businessHours && typeof update.businessHours === 'object') {
          const bh = update.businessHours;
          const startHour = Number(bh.startHour);
          const endHour = Number(bh.endHour);
          if (!Number.isFinite(startHour) || startHour < 0 || startHour > 23) throw new Error('invalid startHour');
          if (!Number.isFinite(endHour) || endHour < 1 || endHour > 24) throw new Error('invalid endHour');
          if (!Array.isArray(bh.days) || bh.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
            throw new Error('invalid days (expect array of 0-6, 0=Sunday)');
          }
          config.businessHours = {
            enabled: bh.enabled !== false,
            days: bh.days,
            startHour,
            endHour,
          };
        }
        persistConfig();
        logEvent('config-update', `updated via dashboard: ${body}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.url === '/api/backends' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const input = JSON.parse(body || '{}');
        const name = String(input.name || '').trim();
        const baseUrl = String(input.baseUrl || '').trim();
        const token = String(input.token || '').trim();
        if (!name) throw new Error('name is required');
        if (backends.some((b) => b.name === name)) throw new Error(`backend "${name}" already exists`);
        if (!baseUrl) throw new Error('baseUrl is required');
        try {
          new URL(baseUrl);
        } catch {
          throw new Error('baseUrl is not a valid URL');
        }
        if (!token) throw new Error('token is required');

        const maxPriority = backends.reduce((m, b) => Math.max(m, b.priority), 0);
        const priority = Number.isFinite(Number(input.priority)) && input.priority !== ''
          ? Number(input.priority)
          : maxPriority + 1;

        const backend = {
          name,
          baseUrl,
          token,
          priority,
          businessHoursAware: !!input.businessHoursAware,
          healthy: true,
          requests: 0,
          errors: 0,
          lastLatencyMs: null,
          lastError: null,
          lastSwitchAt: null,
          lastUsedAt: null,
          retryAfterAt: null,
          hardCooldown: false,
        };
        if (input.modelOverride && String(input.modelOverride).trim()) {
          backend.modelOverride = String(input.modelOverride).trim();
        }
        backends.push(backend);
        recomputePriorityOrder();
        persistConfig();
        logEvent('backend-added', `${name} added via dashboard (priority ${priority})`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.url === '/api/backends/remove' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body || '{}');
        const idx = backends.findIndex((b) => b.name === name);
        if (idx === -1) throw new Error(`unknown backend: ${name}`);
        if (backends.length <= 1) throw new Error('cannot remove the last remaining backend');
        backends.splice(idx, 1);
        if (config.pinnedBackend === name) config.pinnedBackend = null;
        currentIndex = 0;
        recomputePriorityOrder();
        persistConfig();
        logEvent('backend-removed', `${name} removed via dashboard`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  const htmlHeaders = { 'content-type': 'text/html' };
  const queryToken = reqUrl.searchParams.get('token');
  if (config.dashboardToken && queryToken === config.dashboardToken) {
    htmlHeaders['set-cookie'] = `dt=${queryToken}; Path=/; HttpOnly; SameSite=Strict`;
  }
  res.writeHead(200, htmlHeaders);
  res.end(DASHBOARD_HTML);
});

dashboardServer.listen(config.dashboardPort, '127.0.0.1', () => {
  const url = config.dashboardToken
    ? `http://127.0.0.1:${config.dashboardPort}/?token=${config.dashboardToken}`
    : `http://127.0.0.1:${config.dashboardPort}/ (no auth)`;
  logEvent('startup', `dashboard listening: ${url}`);
  console.log(`Dashboard: ${url}`);
});

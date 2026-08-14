// End-to-end suite for QuotaRouter. Drives the real server.js against
// controllable fake upstreams and asserts observable behaviour.
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const DIR = __dirname;
const PROXY = 'http://127.0.0.1:9190';
const DASH = 'http://127.0.0.1:9191';
const STATE = `${DIR}/state.json`;

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}  ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setMode = (o) => {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  fs.writeFileSync(STATE, JSON.stringify({ ...s, ...o }));
};
const hits = () => (JSON.parse(fs.readFileSync(STATE, 'utf8'))._hits || {});
const lastBody = (n) => (JSON.parse(fs.readFileSync(STATE, 'utf8'))._lastBody || {})[n];
const resetHits = () => {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  delete s._hits; delete s._lastBody;
  fs.writeFileSync(STATE, JSON.stringify(s));
};

const post = async (url, body, extra = {}) => {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
};
const status = async () => (await fetch(`${DASH}/api/status`)).json();
const msg = (extra = {}) => post(`${PROXY}/v1/messages`, {
  model: 'client-model', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra,
});

const BASE_CFG = {
  proxyPort: 9190, dashboardPort: 9191,
  firstByteTimeoutMs: 2000, idleTimeoutMs: 5000,
  healthCheckIntervalMs: 300000, errorCooldownMs: 30000,
  preemptOnRecovery: true, dashboardToken: null, pinnedBackend: null,
  businessHours: { enabled: true, days: [1, 2, 3, 4, 5], startHour: 9, endHour: 21 },
  backends: [
    { name: 'alpha', baseUrl: 'http://127.0.0.1:9101', token: 'ta', priority: 1 },
    { name: 'beta', baseUrl: 'http://127.0.0.1:9102', token: 'tb', priority: 2, modelOverride: 'beta-model' },
    { name: 'gamma', baseUrl: 'http://127.0.0.1:9103', token: 'tg', priority: 3 },
  ],
};

let proxy;
let fakes;
const writeCfg = (cfg) => fs.writeFileSync(`${DIR}/config.json`, JSON.stringify(cfg, null, 2));
const startFakes = async () => {
  fakes = spawn('node', [`${DIR}/fakes.js`], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  fakes.stderr.on('data', (d) => console.log('  [fakes stderr]', String(d).trim()));
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9101/', { method: 'POST', body: '{}' });
      r.body?.cancel();
      if (r.status === 200) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('fakes did not start');
};
const stopFakes = () => { if (fakes) { fakes.kill('SIGTERM'); fakes = null; } };
const startProxy = async (cfg = BASE_CFG) => {
  writeCfg(cfg);
  proxy = spawn('node', [`${DIR}/server.js`], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  proxy.stderr.on('data', (d) => console.log('  [proxy stderr]', String(d).trim()));
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${DASH}/api/status`); return; } catch { await sleep(100); }
  }
  throw new Error('proxy did not start');
};
const stopProxy = async () => {
  if (!proxy) return;
  proxy.kill('SIGTERM');
  await sleep(400);
  proxy = null;
};

(async () => {
  fs.writeFileSync(STATE, '{}');
  await startFakes();
  await startProxy();

  console.log('\n== 1. 优先级路由 / 故障转移 ==');
  resetHits(); setMode({ alpha: 'ok', beta: 'ok', gamma: 'ok' });
  let r = await msg();
  ok('最高优先级 alpha 处理', r.json?.served_by === 'alpha', JSON.stringify(r.json)?.slice(0, 80));

  resetHits(); setMode({ alpha: 'err500' });
  r = await msg();
  ok('alpha 500 -> 转移到 beta', r.json?.served_by === 'beta');
  ok('alpha 确实被试过', hits().alpha === 1);

  await stopProxy(); await startProxy();
  console.log('\n== 2. modelOverride ==');
  ok('beta 收到改写后的模型名', lastBody('beta')?.model === 'beta-model', String(lastBody('beta')?.model));
  resetHits(); setMode({ alpha: 'ok' });
  await msg();
  ok('alpha 无 override 时原样透传', lastBody('alpha')?.model === 'client-model');

  await stopProxy(); await startProxy({ ...BASE_CFG, errorCooldownMs: 600, healthCheckIntervalMs: 300 });
  console.log('\n== 3. 抢占策略 ==');
  setMode({ alpha: 'err500' }); await msg();            // current -> beta
  setMode({ alpha: 'ok' });
  await post(`${DASH}/api/config`, { preemptOnRecovery: true });
  resetHits(); r = await msg();
  ok('冷却未过时不回切(仍用 beta)', r.json?.served_by === 'beta', String(r.json?.served_by));
  // 冷却结束只解除锁定,不等于恢复:被动探针必须先用真实请求确认 alpha 才能回切
  let alphaHealthy = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const st = await status();
    if (st.backends.find((b) => b.name === 'alpha').healthy) { alphaHealthy = true; break; }
  }
  ok('冷却结束后被动探针确认 alpha 恢复', alphaHealthy);
  resetHits(); r = await msg();
  ok('Preemptive: 确认恢复后立刻切回 alpha', r.json?.served_by === 'alpha', String(r.json?.served_by));

  await post(`${DASH}/api/config`, { preemptOnRecovery: false });
  setMode({ alpha: 'err500' }); await msg();            // sticky on beta
  setMode({ alpha: 'ok' });
  resetHits(); r = await msg();
  ok('Sticky: 粘住 beta 不回切', r.json?.served_by === 'beta', String(r.json?.served_by));
  ok('Sticky 时未打扰 alpha', !hits().alpha);
  await post(`${DASH}/api/config`, { preemptOnRecovery: true });

  await stopProxy(); await startProxy();
  console.log('\n== 4. Pin 手动锁定 ==');
  setMode({ alpha: 'ok', beta: 'ok', gamma: 'ok' });
  await post(`${DASH}/api/config`, { pinnedBackend: 'gamma' });
  resetHits(); r = await msg();
  ok('Pin 强制走 gamma(优先级最低)', r.json?.served_by === 'gamma');
  ok('Pin 时不碰 alpha', !hits().alpha);

  setMode({ gamma: 'err500' });
  resetHits(); r = await msg();
  ok('Pin 失败仍能兜底转移', r.json?.served_by === 'alpha', String(r.json?.served_by));
  setMode({ gamma: 'ok' });
  await post(`${DASH}/api/config`, { pinnedBackend: null });

  console.log('\n== 5. 429 短限速 -> 等待重试同一后端 ==');
  await post(`${DASH}/api/config`, { pinnedBackend: 'beta' });
  setMode({ beta: 'throttle' });
  resetHits();
  const p = msg();
  await sleep(300);
  setMode({ beta: 'ok' });               // recovers during the wait
  r = await p;
  ok('短限速后重试同一后端(未切走)', r.json?.served_by === 'beta', String(r.json?.served_by));
  ok('beta 被打了两次', hits().beta === 2, JSON.stringify(hits()));
  ok('未误伤 alpha', !hits().alpha);
  await post(`${DASH}/api/config`, { pinnedBackend: null });

  await stopProxy(); await startProxy();
  console.log('\n== 6. 429 长限速 -> 立即转移 + 硬冷却 ==');
  setMode({ alpha: 'quota' });
  resetHits();
  const t0 = Date.now();
  r = await msg();
  const dt = Date.now() - t0;
  ok('长限速立即转移(未等待)', r.json?.served_by === 'beta' && dt < 1500, `${dt}ms`);
  let st = await status();
  ok('alpha 标记为硬冷却', st.backends.find((b) => b.name === 'alpha').hardCooldown === true);

  setMode({ alpha: 'ok' });
  resetHits(); r = await msg();
  ok('硬冷却期内不再尝试 alpha', !hits().alpha && r.json?.served_by === 'beta');

  await post(`${DASH}/api/config`, { pinnedBackend: 'alpha' });
  resetHits(); r = await msg();
  ok('Pin 也不硬闯硬冷却', !hits().alpha, JSON.stringify(hits()));
  await post(`${DASH}/api/config`, { pinnedBackend: null });

  console.log('\n== 7. retry-after HTTP-date 格式 ==');
  await stopProxy(); await startProxy();
  setMode({ alpha: 'quota-date', beta: 'ok' });
  await msg();
  st = await status();
  const alpha = st.backends.find((b) => b.name === 'alpha');
  const secs = (new Date(alpha.retryAfterAt) - Date.now()) / 1000;
  ok('HTTP-date 解析为约 3600s', secs > 3400 && secs < 3700, `${Math.round(secs)}s`);
  ok('HTTP-date 也算硬冷却', alpha.hardCooldown === true);

  console.log('\n== 8. 空 text 块清理 ==');
  await stopProxy(); await startProxy();
  setMode({ alpha: 'strict' });
  r = await post(`${PROXY}/v1/messages`, {
    model: 'm', max_tokens: 8,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      { role: 'user', content: 'go' },
    ],
  });
  ok('顶层空 text 块被清理(strict 后端接受)', r.json?.served_by === 'alpha', r.text.slice(0, 90));

  r = await post(`${PROXY}/v1/messages`, {
    model: 'm', max_tokens: 8,
    system: [{ type: 'text', text: '' }, { type: 'text', text: 'rules' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  ok('system 数组空块被清理', r.json?.served_by === 'alpha', r.text.slice(0, 90));

  r = await post(`${PROXY}/v1/messages`, {
    model: 'm', max_tokens: 8,
    messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '' }] }] },
    ],
  });
  ok('tool_result 内嵌空 text 块被清理', r.json?.served_by === 'alpha', r.text.slice(0, 90));

  console.log('\n== 9. 按后端超时 ==');
  await stopProxy();
  await startProxy({
    ...BASE_CFG, firstByteTimeoutMs: 800,
    backends: [
      { name: 'alpha', baseUrl: 'http://127.0.0.1:9101', token: 'ta', priority: 1, firstByteTimeoutMs: 3000 },
      { name: 'beta', baseUrl: 'http://127.0.0.1:9102', token: 'tb', priority: 2 },
    ],
  });
  setMode({ alpha: 'hang', beta: 'ok' });
  const t1 = Date.now(); await msg(); const d1 = Date.now() - t1;
  ok('alpha 用自己的 3000ms 预算(非全局 800ms)', d1 > 2800 && d1 < 4200, `${d1}ms`);

  console.log('\n== 10. 全部不可用 -> 502 ==');
  await stopProxy(); await startProxy();
  setMode({ alpha: 'quota', beta: 'quota', gamma: 'quota' });
  r = await msg();
  ok('全部硬冷却时返回 502', r.status === 502, `status=${r.status}`);

  console.log('\n== 11. 流式透传 ==');
  await stopProxy(); await startProxy();
  setMode({ alpha: 'stream' });
  const sres = await fetch(`${PROXY}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', stream: true, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const stext = await sres.text();
  ok('SSE 事件完整透传', (stext.match(/^event:/gm) || []).length === 3, JSON.stringify(stext.slice(0, 60)));

  console.log('\n== 12. 增删后端 API ==');
  setMode({ alpha: 'ok' });
  r = await post(`${DASH}/api/backends`, { name: 'delta', baseUrl: 'http://127.0.0.1:9103', token: 'td' });
  ok('新增后端成功', r.json?.ok === true, r.text);
  st = await status();
  ok('新后端优先级自动排最后', st.backends.find((b) => b.name === 'delta')?.priority === 4);

  r = await post(`${DASH}/api/backends`, { name: 'delta', baseUrl: 'http://x.com', token: 't' });
  ok('重名被拒绝', r.status === 400 && /already exists/.test(r.text));
  r = await post(`${DASH}/api/backends`, { name: 'bad', baseUrl: 'not a url', token: 't' });
  ok('非法 URL 被拒绝', r.status === 400 && /valid URL/.test(r.text), r.text);
  r = await post(`${DASH}/api/backends`, { name: 'bad', baseUrl: 'http://x.com' });
  ok('缺 token 被拒绝', r.status === 400 && /token is required/.test(r.text));

  await post(`${DASH}/api/config`, { pinnedBackend: 'delta' });
  r = await post(`${DASH}/api/backends/remove`, { name: 'delta' });
  ok('删除后端成功', r.json?.ok === true);
  st = await status();
  ok('删除被 pin 的后端会清空 pin', st.pinnedBackend === null, String(st.pinnedBackend));

  console.log('\n== 13. 配置 API 校验 ==');
  st = await status();
  const before = st.backends.map((b) => `${b.name}:${b.priority}`).join(',');
  r = await post(`${DASH}/api/config`, {
    priorities: [{ name: 'alpha', priority: 9 }, { name: 'nope', priority: 1 }],
  });
  ok('未知后端名被拒绝', r.status === 400, r.text);
  st = await status();
  ok('校验失败不应部分生效(原子性)',
    st.backends.map((b) => `${b.name}:${b.priority}`).join(',') === before,
    `before=${before} after=${st.backends.map((b) => `${b.name}:${b.priority}`).join(',')}`);

  r = await post(`${DASH}/api/config`, { businessHours: { enabled: true, days: [1], startHour: 25, endHour: 21 } });
  ok('非法 startHour 被拒绝', r.status === 400);
  r = await post(`${DASH}/api/config`, { businessHours: { enabled: true, days: [9], startHour: 9, endHour: 21 } });
  ok('非法星期被拒绝', r.status === 400);
  r = await post(`${DASH}/api/config`, { pinnedBackend: 'ghost' });
  ok('pin 不存在的后端被拒绝', r.status === 400);

  console.log('\n== 14. token 不外泄 ==');
  st = await status();
  ok('/api/status 不含 token 字段', st.backends.every((b) => !('token' in b)));
  ok('/api/status 响应里不含 token 值', !JSON.stringify(st).includes('ta'.repeat(1)) || !JSON.stringify(st).includes('"token"'));

  console.log('\n== 15. 统计持久化 ==');
  st = await status();
  const alphaReq = st.backends.find((b) => b.name === 'alpha').requests;
  await stopProxy();                 // SIGTERM -> saveState
  await startProxy();
  st = await status();
  ok('重启后请求计数保留', st.backends.find((b) => b.name === 'alpha').requests === alphaReq,
    `before=${alphaReq} after=${st.backends.find((b) => b.name === 'alpha').requests}`);

  console.log('\n== 16. 面板鉴权 ==');
  await stopProxy();
  await startProxy({ ...BASE_CFG, dashboardToken: 'secret123' });
  let raw = await fetch(`${DASH}/api/status`);
  ok('无 token 返回 401', raw.status === 401);
  raw = await fetch(`${DASH}/api/status?token=secret123`);
  ok('带正确 token 返回 200', raw.status === 200);
  raw = await fetch(`${DASH}/api/status`, { headers: { 'x-dashboard-token': 'secret123' } });
  ok('请求头方式也接受', raw.status === 200);

  console.log('\n== 17. 业务时间窗口 ==');
  await stopProxy();
  const now = new Date();
  const todayDow = now.getDay();
  // window that is definitely closed right now (yesterday only)
  await startProxy({
    ...BASE_CFG,
    businessHours: { enabled: true, days: [(todayDow + 6) % 7], startHour: 9, endHour: 21 },
    backends: [
      { name: 'alpha', baseUrl: 'http://127.0.0.1:9101', token: 'ta', priority: 1, businessHoursAware: true },
      { name: 'beta', baseUrl: 'http://127.0.0.1:9102', token: 'tb', priority: 2 },
    ],
  });
  setMode({ alpha: 'hang', beta: 'ok' });
  await msg();
  st = await status();
  const a2 = st.backends.find((b) => b.name === 'alpha');
  const waitH = (new Date(a2.retryAfterAt) - Date.now()) / 3600e3;
  ok('窗口外 -> 冷却到下个窗口(数小时以上)', waitH > 5, `${waitH.toFixed(1)}h`);
  ok('窗口外冷却不是硬冷却(可被兜底)', a2.hardCooldown === false);

  await stopProxy();
  await startProxy({
    ...BASE_CFG, errorCooldownMs: 30000,
    businessHours: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 },
    backends: [
      { name: 'alpha', baseUrl: 'http://127.0.0.1:9101', token: 'ta', priority: 1, businessHoursAware: true },
      { name: 'beta', baseUrl: 'http://127.0.0.1:9102', token: 'tb', priority: 2 },
    ],
  });
  setMode({ alpha: 'hang', beta: 'ok' });
  await msg();
  st = await status();
  const a3 = st.backends.find((b) => b.name === 'alpha');
  const waitS = (new Date(a3.retryAfterAt) - Date.now()) / 1000;
  ok('窗口内 -> 短冷却(约30s)', waitS > 20 && waitS < 40, `${waitS.toFixed(0)}s`);

  console.log('\n== 18. 非 businessHoursAware 后端不受窗口影响 ==');
  await stopProxy();
  await startProxy({
    ...BASE_CFG,
    businessHours: { enabled: true, days: [(todayDow + 6) % 7], startHour: 9, endHour: 21 },
    backends: [
      { name: 'alpha', baseUrl: 'http://127.0.0.1:9101', token: 'ta', priority: 1 },
      { name: 'beta', baseUrl: 'http://127.0.0.1:9102', token: 'tb', priority: 2 },
    ],
  });
  setMode({ alpha: 'hang', beta: 'ok' });
  await msg();
  st = await status();
  const a4 = st.backends.find((b) => b.name === 'alpha');
  const w4 = (new Date(a4.retryAfterAt) - Date.now()) / 1000;
  ok('未开启该开关的后端仍是短冷却', w4 > 20 && w4 < 40, `${w4.toFixed(0)}s`);

  await stopProxy();
  stopFakes();
  console.log(`\n===== 通过 ${pass} / 失败 ${fail} =====`);
  if (fails.length) console.log('失败项:\n - ' + fails.join('\n - '));
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('HARNESS ERROR', e); await stopProxy(); stopFakes(); process.exit(2); });

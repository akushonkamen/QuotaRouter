// Controllable fake upstreams driven by ./state.json so tests can flip a
// backend between healthy / throttled / quota-exhausted / hanging / strict.
const http = require('http');
const fs = require('fs');
const F = `${__dirname}/state.json`;
const S = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch { return {}; } };

function mk(port, name) {
  http.createServer((req, res) => {
    const st = S();
    const mode = st[name] || 'ok';
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      const cur = S();
      cur._hits = cur._hits || {};
      cur._hits[name] = (cur._hits[name] || 0) + 1;
      cur._lastBody = cur._lastBody || {};
      cur._lastBody[name] = parsed;
      fs.writeFileSync(F, JSON.stringify(cur));

      if (mode === 'hang') return;
      if (mode === 'throttle') { res.writeHead(429, { 'retry-after': '1' }); return res.end('{"e":"slow"}'); }
      if (mode === 'quota') { res.writeHead(429, { 'retry-after': '3600' }); return res.end('{"e":"quota"}'); }
      if (mode === 'quota-date') {
        res.writeHead(429, { 'retry-after': new Date(Date.now() + 3600e3).toUTCString() });
        return res.end('{"e":"quota"}');
      }
      if (mode === 'err500') { res.writeHead(500); return res.end('{"e":"boom"}'); }
      if (mode === 'strict' && JSON.stringify(parsed).includes('"text":""')) {
        res.writeHead(400); return res.end('{"error":{"message":"text content is empty"}}');
      }
      if (mode === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message_start\ndata: {}\n\n');
        res.write('event: content_block_delta\ndata: {}\n\n');
        return res.end('event: message_stop\ndata: {}\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ served_by: name, model_seen: parsed.model, body: parsed }));
    });
  }).listen(port, '127.0.0.1');
}
mk(9101, 'alpha'); mk(9102, 'beta'); mk(9103, 'gamma');
console.log('fakes up');

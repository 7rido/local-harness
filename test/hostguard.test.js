// node --test test
// The Host guard and the extra allowed addresses. Through a tunnel or port forward the Host header is the other
// machine's address, and the guard would answer 403 to it, so LH_ALLOWED_HOSTS lists extra private addresses.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-hostguard-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7571';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'none.txt');

const bind = require('../src/bind');
const { makeServer } = require('../src/server');

test('only private addresses with a port are accepted as extra hosts', () => {
  const ok = bind.extraHostHeaders({ LH_ALLOWED_HOSTS: '100.64.1.2:7077, 192.168.1.5:7077,[fd7a:115c:a1e0::1]:7077,127.0.0.1:9' });
  assert.deepStrictEqual([...ok].sort(), ['100.64.1.2:7077', '127.0.0.1:9', '192.168.1.5:7077', '[fd7a:115c:a1e0::1]:7077']);
  assert.deepStrictEqual([...bind.extraHostHeaders({})], []);
  for (const bad of ['evil.example:7077', '8.8.8.8:7077', '100.64.1.2', '100.64.1.2:0', '100.64.1.2:99999', '0.0.0.0:7077', '*:7077', 'localhost.evil.example:7077',
    '1.2.3.4.5:7077', '999.1.1.1:7077', '[2001:4860:4860::8888]:7077']) {
    assert.throws(() => bind.extraHostHeaders({ LH_ALLOWED_HOSTS: bad }), /not accepted/, bad);
  }
  assert.throws(() => bind.extraHostHeaders({ LH_ALLOWED_HOSTS: '100.64.1.2:7077,evil.example:7077' }), /evil\.example:7077 not accepted/, 'one bad entry refuses the list');
});

test('the guard accepts the listed addresses and still refuses everything else', () => {
  const extra = bind.extraHostHeaders({ LH_ALLOWED_HOSTS: '100.64.1.2:7077' });
  const names = bind.allowedHostHeaders({ loopback: true }, 7077, {}, extra);
  assert.ok(names.has('127.0.0.1:7077') && names.has('localhost:7077') && names.has('100.64.1.2:7077'));
  assert.ok(!names.has('100.64.1.3:7077') && !names.has('evil.example:7077') && !names.has('100.64.1.2:7078'));
  assert.deepStrictEqual([...bind.allowedHostHeaders({ loopback: true }, 7077, {})].sort(), ['127.0.0.1:7077', 'localhost:7077'], 'with no extras it is as before');
});

function get(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
}

test('a server with an extra host answers that Host and 403s a stranger', async (t) => {
  const extra = bind.extraHostHeaders({ LH_ALLOWED_HOSTS: '100.64.1.2:7571' });
  const srv = makeServer('h'.repeat(48), { allowedHosts: bind.allowedHostHeaders({ loopback: true }, 7571, {}, extra) });
  await new Promise((r) => srv.listen(7571, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  assert.strictEqual(await get(7571, '127.0.0.1:7571'), 200);
  assert.strictEqual(await get(7571, '100.64.1.2:7571'), 200, 'a private address, through the tunnel');
  assert.strictEqual(await get(7571, '100.64.1.9:7571'), 403);
  assert.strictEqual(await get(7571, 'evil.example:7571'), 403, 'DNS rebinding is still refused');
  assert.strictEqual(await get(7571, '127.0.0.1:7572'), 403);
});

// node --test test
// Where the harness listens: loopback by default, other addresses only through LH_HOST, and only private ones.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-bind-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7591';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'none.txt');

const bind = require('../src/bind');
const { makeServer } = require('../src/server');

test('bind: loopback is the default; other addresses need LH_HOST, and must be private', () => {
  assert.deepStrictEqual(bind.resolveBind({}), { host: '127.0.0.1', loopback: true, all: false, warning: null });
  assert.strictEqual(bind.resolveBind({ LH_HOST: 'localhost' }).host, '127.0.0.1');
  for (const ok of ['192.168.1.20', '10.0.0.5', '172.16.4.4', '100.101.102.103', 'fd7a:115c:a1e0::1']) {
    const r = bind.resolveBind({ LH_HOST: ok });
    assert.deepStrictEqual([r.host, r.loopback, r.all], [ok, false, false], ok);
    assert.match(r.warning, /token is required/);
  }
  for (const bad of ['8.8.8.8', '203.0.113.9', 'example.com', '2001:4860:4860::8888']) {
    assert.throws(() => bind.resolveBind({ LH_HOST: bad }), /not a private address|must be an IP/, bad);
  }
  assert.throws(() => bind.resolveBind({ LH_HOST: '0.0.0.0' }), /every network/);
  const all = bind.resolveBind({ LH_HOST: '0.0.0.0', LH_ALLOW_ALL_INTERFACES: 'yes' });
  assert.strictEqual(all.all, true);
  assert.match(all.warning, /EVERY network interface/);
});

test('the Host guard follows the bind: loopback names only, plus the one private address when asked for', () => {
  assert.deepStrictEqual([...bind.allowedHostHeaders(bind.resolveBind({}), 8787)].sort(), ['127.0.0.1:8787', 'localhost:8787']);
  const where = bind.resolveBind({ LH_HOST: '192.168.1.20' });
  assert.ok(bind.allowedHostHeaders(where, 8787).has('192.168.1.20:8787'));
  assert.deepStrictEqual(bind.pairingUrls(where, 8787, 'T'), ['http://127.0.0.1:8787/?t=T', 'http://192.168.1.20:8787/?t=T']);
});

test('the token is required from any address, and the default server accepts only loopback host names', async (t) => {
  const token = 'z'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7591, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  const get = (host, pathname, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 7591, path: pathname, headers: { host, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.strictEqual(await get('127.0.0.1:7591', '/'), 200, 'the page itself needs no token (it holds none)');
  assert.strictEqual(await get('127.0.0.1:7591', '/api/conversations'), 401);
  assert.strictEqual(await get('127.0.0.1:7591', '/api/conversations?t=wrong'), 401);
  assert.strictEqual(await get('127.0.0.1:7591', '/api/conversations', { 'x-lh-token': token }), 200);
  assert.strictEqual(await get('192.168.1.20:7591', '/'), 403, 'a private host name is refused unless LH_HOST allowed it');
  assert.strictEqual(await get('evil.example:7591', '/'), 403);
});

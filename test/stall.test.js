// node --test test
// A model server that goes silent mid-reply (dead, or its link gone) would hold the call open until the 20-minute cap.
// A stall timer on the streamed reply ends it as a failure instead.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-stall-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7441';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7442';
process.env.LH_MODEL_STALL_MS = '500';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'none.txt');

const lib = require('../src/lib');
const { makeServer } = require('../src/server');

const H = { 'content-type': 'application/json', 'x-lh-token': 'c'.repeat(48) };
const BASE = 'http://127.0.0.1:7441';

test('a model server that goes silent mid-reply ends the call as a failure, and nothing is saved as the reply', async () => {
  // Sends the headers and one piece, then nothing, and never closes: a dead peer.
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive 1/2\n\n');
      res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'm', created: 1,
        choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'Half' } }] }) + '\n\n');
    });
  });
  await new Promise((r) => fake.listen(7442, '127.0.0.1', r));
  const srv = makeServer('c'.repeat(48));
  await new Promise((r) => srv.listen(7441, '127.0.0.1', r));
  try {
    const { conv_id } = await (await fetch(`${BASE}/api/new`, { method: 'POST', headers: H })).json();
    const started = Date.now();
    const r = await (await fetch(`${BASE}/api/send`, { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: 'hello' }) })).json();
    assert.ok(Date.now() - started < 10000, 'it ended in seconds, not at the 20-minute cap');
    assert.strictEqual(r.failed.reason, 'the model server went silent');
    const conv = lib.readJsonl(path.join(TMP, 'conversations', `${conv_id}.jsonl`));
    assert.ok(!conv.some((m) => m.author === 'model'), 'the half reply is not saved');
    const failed = lib.readJsonl(path.join(TMP, 'logs', `${conv_id}.jsonl`)).filter((e) => e.event === 'model call failed');
    assert.strictEqual(failed.length, 1, 'logged once, and not sent again');
    assert.match(failed[0].detail, /sent nothing for (0|1) seconds/);
    assert.strictEqual(failed[0].pieces_received, 1);
  } finally {
    for (const x of [fake, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); }
  }
});

// node --test test
// Searching past chats: the search_chats tool. A fake model server. Invented chats only.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-recall-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7461';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7462';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');

const recall = require('../src/recall');
const tools = require('../src/tools');
const approvals = require('../src/approvals');
const { makeServer } = require('../src/server');

const CONV = path.join(TMP, 'conversations');
const SECRET = 'Thursday at three';

function setTrust(obj) { fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify(obj)); }
function reset() { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} }

function writeChat(id, turns) {
  fs.mkdirSync(CONV, { recursive: true });
  const src = { user: 'user', model: 'model', tool: 'tool' };
  fs.writeFileSync(path.join(CONV, `${id}.jsonl`), turns.map(([author, text], i) => JSON.stringify({
    id: `m-${id}-${i}`, conv_id: id, ts: `2026-11-1${i % 9}T10:00:00.000Z`, author, source: src[author], text,
  })).join('\n') + '\n');
}
function filesWith(text, dir = TMP) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesWith(text, p));
    else if (fs.readFileSync(p, 'utf8').includes(text)) out.push(path.relative(TMP, p));
  }
  return out;
}

test('search: never the current chat, rarer words first; on by default, off with "off"', () => {
  reset();
  fs.rmSync(CONV, { recursive: true, force: true });
  writeChat('c-dog', [['user', `Pip has a vet appointment ${SECRET}`], ['model', 'I hope the vet visit goes well for Pip.']]);
  writeChat('c-cat', [['user', 'Pip the dog again'], ['model', 'Pip vet']]);
  writeChat('c-soup', [['user', 'Soup ideas for the week'], ['model', 'Lentil soup, then tomato soup.']]);
  const r = recall.search('vet appointment for Pip', { exceptConvId: 'c-soup' });
  assert.deepStrictEqual(r.map((x) => x.conv_id), ['c-dog', 'c-cat'], 'the best match first');
  assert.strictEqual(r[0].reply_id, 'm-c-dog-1');
  assert.ok(!recall.search('vet Pip', { exceptConvId: 'c-dog' }).some((x) => x.conv_id === 'c-dog'), 'never the chat the model is in');
  assert.deepStrictEqual(recall.search('the and with'), [], 'common words alone match nothing');
  assert.strictEqual(recall.live(), true);
  assert.ok(tools.offeredSchemas().some((s) => s.function.name === 'search_chats'));
  setTrust({ search_chats: 'off' });
  assert.strictEqual(recall.live(), false);
  assert.ok(!tools.offeredSchemas().some((s) => s.function.name === 'search_chats'));
  reset();
  const text = recall.render(r.slice(0, 1));
  assert.ok(text.startsWith(recall.WORDING.found) && text.includes(SECRET) && text.includes('I hope the vet visit'));
  assert.strictEqual(recall.render([]), recall.WORDING.none);
});

test('end to end: the model looks back on its own, the reply names the chat, the logs keep only ids, and forgetting the chat removes it', async (t) => {
  reset();
  fs.rmSync(CONV, { recursive: true, force: true });
  writeChat('c-dog', [['user', `Pip has a vet appointment ${SECRET}`], ['model', 'I hope the vet visit goes well for Pip.']]);
  const seen = [];
  const fake = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); return res.end('{"data":[]}'); }
      const body = JSON.parse(s); seen.push(body);
      const last = body.messages[body.messages.length - 1];
      const message = last.role === 'tool'
        ? { role: 'assistant', content: 'You mentioned the vet visit for Pip. How did it go?' }
        : { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'search_chats', arguments: '{"query":"Pip vet appointment"}' } }] };
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 30 }, choices: [{ finish_reason: 'stop', message }] }));
    });
  });
  await new Promise((r) => fake.listen(7462, '127.0.0.1', r));
  const token = 'r'.repeat(48); const srv = makeServer(token);
  await new Promise((r) => srv.listen(7461, '127.0.0.1', r));
  t.after(async () => { reset(); for (const x of [fake, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const post = async (route, body) => (await fetch('http://127.0.0.1:7461' + route, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json();
  const get = async (route) => (await fetch('http://127.0.0.1:7461' + route, { headers: H })).json();

  const { conv_id } = await post('/api/new');
  const r1 = await post('/api/send', { conv_id, text: 'how is that dog thing going?' });
  assert.strictEqual(r1.reply.tools[0].name, 'search_chats');
  assert.strictEqual(r1.reply.tools[0].decision, 'ran', 'the model looks back on its own');
  const shown = seen[1].messages.find((m) => m.role === 'tool').content;
  assert.ok(shown.includes(SECRET), 'the model sees the past exchange');
  assert.deepStrictEqual(r1.reply.recall.map((x) => x.conv_id), ['c-dog']);
  const log = fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.jsonl`), 'utf8') + fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.md`), 'utf8');
  assert.ok(!log.includes(SECRET), 'the new chat\'s logs keep ids, not the old words');
  const convNow = fs.readFileSync(path.join(CONV, `${conv_id}.jsonl`), 'utf8');
  assert.ok(!convNow.includes(SECRET), 'nor does the new chat\'s transcript');
  const conv = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(conv.recall_chats['c-dog'], `Pip has a vet appointment ${SECRET}`.slice(0, 48), 'the page names the chat');

  // Forget the old chat: its words are gone from everything the harness keeps, and the page just says so.
  await post('/api/forget', { conv_id: 'c-dog' });
  assert.deepStrictEqual(filesWith(SECRET), []);
  const after = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(after.recall_chats['c-dog'], undefined);
});

test('search runs on its own or not at all: "ask" still runs read-only, "off" turns it off, no approval ever runs it', async (t) => {
  fs.rmSync(CONV, { recursive: true, force: true });
  writeChat('c-dog', [['user', `Pip has a vet appointment ${SECRET}`], ['model', 'I hope the vet visit goes well for Pip.']]);
  setTrust({ search_chats: 'ask' });
  const r = await tools.handleCall({ name: 'search_chats', args: { query: 'Pip vet' } }, { convId: 'c-new' });
  assert.strictEqual(r.decision, 'ran');
  assert.strictEqual(r.recall[0].conv_id, 'c-dog');
  assert.deepStrictEqual(approvals.listApprovals(), [], 'no approval written');
  setTrust({ search_chats: 'off' });
  const off2 = await tools.handleCall({ name: 'search_chats', args: { query: 'Pip vet' } }, { convId: 'c-new' });
  assert.match(off2.decision, /^refused/);
  // Even a hand-made approval for it is refused by the server.
  reset();
  const token = 's'.repeat(48); const srv = makeServer(token);
  await new Promise((res) => srv.listen(7461, '127.0.0.1', res));
  t.after(async () => { reset(); srv.closeAllConnections(); await new Promise((res) => srv.close(res)); });
  const apr = approvals.addApproval({ convId: 'c-new', name: 'search_chats', args: { query: 'Pip' } });
  const resp = await fetch('http://127.0.0.1:7461/api/approval', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lh-token': token },
    body: JSON.stringify({ id: apr.id, decision: 'approve' }) });
  assert.strictEqual(resp.status, 400);
  assert.deepStrictEqual(filesWith(SECRET).filter((f) => !f.startsWith('conversations/c-dog')), []);
});

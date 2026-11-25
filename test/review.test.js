// node --test test
// The review and habits: misses, a review run by the model, cards you decide on, and habits shown to the model only while
// review and memory are on. A fake model server; invented chats only.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-review-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7611';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7612';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');

const lib = require('../src/lib');
const review = require('../src/review');
const misses = require('../src/misses');
const memory = require('../src/memory');
const { makeServer } = require('../src/server');

const HABIT_TEXT = 'Check every sum with the calculator tool before stating it';
function setTrust(obj) { fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify(obj)); }
function reset() { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} for (const n of memory.list()) memory.remove(n.id); fs.rmSync(path.join(TMP, 'review'), { recursive: true, force: true }); fs.rmSync(path.join(TMP, 'misses.jsonl'), { force: true }); }

async function boot(t, token, { reviewReplies = true } = {}) {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      if (req.method === 'GET') return res.end('{"data":[{"id":"fake"}]}');
      const body = JSON.parse(s); seen.push(body);
      const text = body.messages.map((m) => m.content).join('\n');
      let content = /capital of Atlantis/.test(String(body.messages[body.messages.length - 1].content)) ? 'The capital is Poseidonis.' : '17 × 24 = 418.';
      if (/write only "NONE"/.test(text)) content = 'MISTAKE 1: the product was wrong';
      else if (/Write exactly two lines/.test(text)) content = reviewReplies ? `KIND: Arithmetic slip\nHABIT: ${HABIT_TEXT}` : 'no idea';
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 9 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] }));
    });
  });
  await new Promise((r) => fake.listen(7612, '127.0.0.1', r));
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7611, '127.0.0.1', r));
  t.after(async () => { reset(); for (const x of [fake, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const call = async (method, route, body) => { const r = await fetch('http://127.0.0.1:7611' + route, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const post = async (route, body) => (await call('POST', route, body || {})).body;
  const get = async (route) => (await call('GET', route)).body;
  const until = async (fn) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
  return { seen, post, get, call, until };
}

test('off by default: no marking, no run, no habits block; and it needs memory on as well', async (t) => {
  reset();
  const { post, call } = await boot(t, 'a'.repeat(48));
  assert.strictEqual(review.status().on, false);
  assert.match(review.status().why_off, /trust\.json/);
  const { conv_id } = await post('/api/new');
  const r = await post('/api/send', { conv_id, text: 'What is 17 × 24?' });
  assert.strictEqual(r.reply.arithmetic_slips.length, 1, 'the check still shows the slip');
  assert.strictEqual(misses.listMisses().length, 0, 'but nothing is logged while the review is off');
  assert.strictEqual((await call('POST', '/api/miss', { conv_id, message_id: r.reply.id, expected: '408' })).status, 400);
  assert.strictEqual((await call('POST', '/api/review/run', {})).status, 400);
  setTrust({ review: 'on' });
  assert.strictEqual(review.status().on, false);
  assert.match(review.status().why_off, /memory is off/);
  assert.strictEqual((await call('POST', '/api/review/run', {})).status, 400);
  assert.strictEqual(review.habitsBlock(), null);
});

test('end to end: a wrong sum and a marked reply are found, the model proposes habits, nothing is kept without your yes, a kept habit reaches the model only while memory is on', async (t) => {
  reset();
  setTrust({ review: 'on', memory: 'on' });
  const { seen, post, get, call, until } = await boot(t, 'b'.repeat(48));
  // Chat 1: a wrong sum (the arithmetic check logs a miss). Chat 2: you mark a reply wrong.
  const a = (await post('/api/new')).conv_id;
  const r1 = await post('/api/send', { conv_id: a, text: 'What is 17 × 24?' });
  const slip = misses.listMisses().find((x) => x.reply_id === r1.reply.id);
  assert.deepStrictEqual([slip.check.kind, slip.check.claimed, slip.check.expected], ['rule:arithmetic', '418', '408']);
  const b = (await post('/api/new')).conv_id;
  const r2 = await post('/api/send', { conv_id: b, text: 'Name the capital of Atlantis.' });
  const marked = await post('/api/miss', { conv_id: b, message_id: r2.reply.id, expected: 'Atlantis has no capital' });
  assert.strictEqual(marked.miss.check.kind, 'user');
  assert.strictEqual((await post('/api/miss', { conv_id: b, message_id: r2.reply.id, expected: 'again' })).already, true, 'the same mark is not logged twice');

  // The review run: the model reads the chats and the misses, and names a kind and a habit for each.
  assert.deepStrictEqual((await post('/api/review/run')), { started: true });
  const done = await until(async () => { const r = await get('/api/review'); return !r.progress && r.status.offered >= 2 ? r : null; });
  assert.ok(done.cases.length >= 2);
  assert.ok(done.cases.every((c) => c.status === 'offered' && c.kind === 'Arithmetic slip' && c.habit === HABIT_TEXT));
  const by = new Set(done.cases.map((c) => c.found_by));
  assert.ok(by.has('rule') && by.has('you'), 'one found by the arithmetic check, one marked by you');
  // Offered is not kept: the next reply carries no habit.
  const before = await post('/api/send', { conv_id: a, text: 'And what is 3 × 5?' });
  const sysBefore = seen[seen.length - 1].messages.find((m) => m.role === 'system');
  assert.ok(!sysBefore || !sysBefore.content.includes(HABIT_TEXT), 'a habit is never shown before your yes');
  assert.deepStrictEqual(before.reply.memory.habit_ids, []);
  // The run log holds ids and shas, never the habit words.
  const runs = fs.readFileSync(review.runsFile(), 'utf8');
  assert.ok(!runs.includes(HABIT_TEXT) && !runs.includes('Atlantis'));
  assert.ok(JSON.parse(runs.split('\n')[0]).wording_sha);

  // Keep one as written, one with your own words; drop none yet.
  const c1 = done.cases.find((c) => c.found_by === 'rule'); const c2 = done.cases.find((c) => c.found_by === 'you');
  const k1 = await post('/api/review/decide', { id: c1.id, decision: 'keep' });
  assert.strictEqual(k1.case.status, 'kept');
  const k2 = await post('/api/review/decide', { id: c2.id, decision: 'keep', kind: 'Made-up fact', habit: 'Say when a place or thing may not exist' });
  assert.strictEqual(k2.case.final_text_by, 'user');
  const after = await post('/api/send', { conv_id: a, text: 'One more sum: 6 × 7?' });
  const sys = seen[seen.length - 1].messages.find((m) => m.role === 'system');
  assert.ok(sys.content.includes(`- Arithmetic slip: ${HABIT_TEXT}`), 'a kept habit is shown to the model');
  assert.ok(sys.content.includes('- Made-up fact: Say when a place or thing may not exist'));
  assert.strictEqual(after.reply.memory.habit_ids.length, 2);
  const log = fs.readFileSync(path.join(TMP, 'logs', `${a}.jsonl`), 'utf8');
  assert.ok(!log.includes(HABIT_TEXT), 'the activity log has habit ids, not their words');
  const conv = await get(`/api/conv/${a}`);
  assert.strictEqual(Object.keys(conv.habits).length, 2, 'the page gets the habits to show under the reply');

  // Memory off: the habits are not shown, though they are kept.
  setTrust({ review: 'on' });
  await post('/api/send', { conv_id: a, text: 'Another one?' });
  const last = seen[seen.length - 1].messages;
  assert.ok(!last.some((m) => typeof m.content === 'string' && m.content.includes(HABIT_TEXT)), 'no habits while memory is off');
  assert.strictEqual(review.habits().length, 2);
  setTrust({ memory: 'on' });
  await post('/api/send', { conv_id: a, text: 'Another one, review off?' });
  assert.ok(!seen[seen.length - 1].messages.some((m) => typeof m.content === 'string' && m.content.includes(HABIT_TEXT)), 'no habits while the review is off');

  // Forgetting a chat deletes its cases and its misses; a kept habit loses every link to the chat and is offered for deletion.
  setTrust({ review: 'on', memory: 'on' });
  const f = await post('/api/forget', { conv_id: a });
  assert.ok(f.removed.misses >= 1);
  assert.ok(f.habits_from_chat.length >= 1);
  assert.ok(!misses.listMisses().some((x) => x.conv_id === a));
  const kept = review.habits().find((h) => h.id === f.habits_from_chat[0]);
  assert.strictEqual(kept.from_forgotten, true);
  for (const key of ['conv_id', 'reply_id', 'question_id', 'miss_id']) assert.ok(!(key in kept), `${key} is gone from a kept habit`);
  assert.ok(!review.list().some((c) => c.conv_id === a), 'no case of the forgotten chat is left');
  // A habit you forget is deleted for good, words and all.
  assert.strictEqual((await call('POST', '/api/review/delete', { id: kept.id })).status, 200);
  const gone = JSON.parse(fs.readFileSync(review.casesFile(), 'utf8')).cases.find((c) => c.id === kept.id);
  assert.deepStrictEqual([gone.status, 'habit' in gone, 'kind' in gone], ['deleted', false, false]);
});

test('dropping a case keeps nothing but its ids; a case with no kind or habit cannot be kept as it is', async (t) => {
  reset();
  setTrust({ review: 'on', memory: 'on' });
  const { post, get, call, until } = await boot(t, 'c'.repeat(48), { reviewReplies: false });
  const a = (await post('/api/new')).conv_id;
  await post('/api/send', { conv_id: a, text: 'What is 17 × 24?' });
  await post('/api/review/run');
  const done = await until(async () => { const r = await get('/api/review'); return !r.progress && r.status.offered ? r : null; });
  const c = done.cases[0];
  assert.ok(!c.kind && !c.habit, 'the model could not name it');
  assert.strictEqual((await call('POST', '/api/review/decide', { id: c.id, decision: 'keep' })).status, 400);
  const dropped = await post('/api/review/decide', { id: c.id, decision: 'drop' });
  assert.strictEqual(dropped.case.status, 'dropped');
  const raw = JSON.parse(fs.readFileSync(review.casesFile(), 'utf8')).cases.find((x) => x.id === c.id);
  assert.ok(!('kind' in raw) && !('habit' in raw) && !('what' in raw));
  // The same reply is not offered again by the next run.
  await post('/api/review/run');
  await until(async () => !(await get('/api/review')).progress);
  assert.strictEqual(review.list().filter((x) => x.reply_id === c.reply_id).length, 0);
});

test('habit lines are capped at 1500 characters', () => {
  reset();
  setTrust({ review: 'on', memory: 'on' });
  fs.mkdirSync(path.dirname(review.casesFile()), { recursive: true });
  const cases = Array.from({ length: 20 }, (_, i) => ({ id: `case-${i}`, status: 'kept', kind: `Kind ${i}`, habit: 'h'.repeat(190), decided: `2026-01-${String(i + 10).padStart(2, '0')}` }));
  fs.writeFileSync(review.casesFile(), JSON.stringify({ version: 1, cases }));
  const hb = review.habitsBlock();
  assert.ok(hb.text.length <= 1500 + 220);
  assert.ok(hb.ids.length < 20 && hb.omitted === 20 - hb.ids.length);
  assert.strictEqual(hb.ids[0], 'case-19', 'newest first');
  reset();
});

test('the review says plainly when the model server is down', async (t) => {
  reset();
  setTrust({ review: 'on', memory: 'on' });
  const token = 'd'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7611, '127.0.0.1', r));
  t.after(async () => { reset(); srv.closeAllConnections(); await new Promise((r) => srv.close(r)); });
  const r = await fetch('http://127.0.0.1:7611/api/review/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lh-token': token }, body: '{}' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /model server is not answering/);
});

test('the page has the Review drawer, the mark-as-a-miss control and the habits line', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  for (const s of ['id="revdrawer"', "'Mark as a miss'", "' in mind'", "'Keep habit'", "'/api/review/run'", "'/api/miss'"]) assert.ok(html.includes(s), s);
  assert.ok(lib.AUTHORS.model, 'sanity');
});

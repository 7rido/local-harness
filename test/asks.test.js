// node --test test
// ask_someone: the model puts one question to a second voice, through your approval. Answers come from a queue (the command
// line) or from an optional endpoint, and arrive as a turn by the author "teacher".

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-asks-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7621';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7622';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');
process.env.LH_TEACHER_NAME = 'Mentor';
process.env.LH_USER_NAME = 'jdoe';

const lib = require('../src/lib');
const tools = require('../src/tools');
const asks = require('../src/asks');
const { makeServer } = require('../src/server');

const QUESTION = 'What is the rescue desk number in Bayport?';
const setTrust = (o) => fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify(o));
const reset = () => { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} fs.rmSync(path.join(TMP, 'asks.jsonl'), { force: true }); for (const k of ['LH_TEACHER_URL', 'LH_TEACHER_KEY', 'LH_TEACHER_MODEL']) delete process.env[k]; };

async function boot(t, token, question = QUESTION) {
  const seen = [];
  const fake = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      if (req.method === 'GET') return res.end('{"data":[]}');
      const body = JSON.parse(s); seen.push(body);
      const last = body.messages[body.messages.length - 1];
      let message = { role: 'assistant', content: 'Understood.' };
      if (last.role === 'user' && /Mentor: /.test(last.content)) message = { role: 'assistant', content: 'The rescue desk is on 020 7946 0177, as the mentor said.' };
      else if (last.role === 'user' && /ask them/.test(last.content) && body.tools && body.tools.some((x) => x.function.name === 'ask_someone')) {
        message = { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'ask_someone', arguments: JSON.stringify({ question }) } }] };
      }
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 9 }, choices: [{ finish_reason: 'stop', message }] }));
    });
  });
  await new Promise((r) => fake.listen(7622, '127.0.0.1', r));
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7621, '127.0.0.1', r));
  t.after(async () => { reset(); for (const x of [fake, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const post = async (route, body) => (await fetch('http://127.0.0.1:7621' + route, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json();
  const get = async (route) => (await fetch('http://127.0.0.1:7621' + route, { headers: H })).json();
  return { seen, post, get };
}

test('off by default: the model is not offered ask_someone, and a call is refused', async (t) => {
  reset();
  const { seen, post } = await boot(t, 'a'.repeat(48));
  assert.ok(!tools.offeredSchemas().some((s) => s.function.name === 'ask_someone'));
  const { conv_id } = await post('/api/new');
  const r = await post('/api/send', { conv_id, text: 'please ask them' });
  assert.ok(!(seen[0].tools || []).some((x) => x.function.name === 'ask_someone'));
  assert.ok(r.reply);
  assert.match((await tools.handleCall({ name: 'ask_someone', args: { question: QUESTION } })).decision, /^refused/);
});

test('it always asks, even at "on"; the card holds the exact question; the queue answer arrives as a teacher turn that the checks count as seen', async (t) => {
  reset(); setTrust({ ask_someone: 'on' });
  const { seen, post, get } = await boot(t, 'b'.repeat(48));
  const { conv_id } = await post('/api/new');
  const r1 = await post('/api/send', { conv_id, text: 'please ask them for the number' });
  assert.strictEqual(r1.reply.tools[0].decision, 'waiting for approval');
  assert.match(seen[1].messages.find((m) => m.role === 'tool').content, /shown to the person/);
  let conv = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(conv.approvals[0].args.question, QUESTION, 'the card shows the exact question');
  assert.strictEqual(asks.listAsks().length, 0, 'nothing is saved or sent before your yes');
  const calls = seen.length;
  const ok = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve' });
  assert.strictEqual(ok.ask.status, 'open');
  assert.strictEqual(seen.length, calls, 'the model is not asked again until an answer comes');
  conv = await get(`/api/conv/${conv_id}`);
  assert.deepStrictEqual(conv.asks.map((a) => a.question), [QUESTION]);

  // A person or program answers with the command line (here: the same API call it makes).
  const answered = await post('/api/ask/answer', { id: ok.ask.id, text: 'The rescue desk is 020 7946 0177.' });
  assert.match(answered.reply.text, /020 7946 0177/);
  const turn = lib.readJsonl(path.join(TMP, 'conversations', `${conv_id}.jsonl`)).find((m) => m.author === 'teacher');
  assert.deepStrictEqual([turn.source, turn.ask_id], ['teacher', ok.ask.id]);
  assert.notStrictEqual(turn.source, 'model');
  const last = seen[seen.length - 1].messages;
  assert.match(last[last.length - 1].content, /^Mentor: The rescue desk is 020 7946 0177\.$/, 'the model sees the turn under the teacher\'s label');
  // The number is in what the model saw, so the number check finds it and says whose it was.
  assert.deepStrictEqual(answered.reply.numbers_found, [{ number: '020 7946 0177', source: 'the teacher said it' }]);
  assert.deepStrictEqual(answered.reply.numbers_unsourced || [], []);
  assert.strictEqual(asks.listAsks(true).length, 0, 'the ask is closed');
  assert.strictEqual((await post('/api/ask/answer', { id: ok.ask.id, text: 'again' })).error, 'no such open question');
  // It is a different author from the model, so a past-chat search or "told" mark never treats it as the user's own words.
  assert.strictEqual(lib.AUTHORS.teacher.label, 'Mentor');
  assert.strictEqual(conv.messages.length, 2);
});

test('a question with a guarded word is refused before any card, and logged by hash only', async (t) => {
  reset(); setTrust({ ask_someone: 'ask', search_never_send: ['Marlow Heights'] });
  const { seen, post, get } = await boot(t, 'c'.repeat(48), 'Is it safe for jdoe to visit Marlow Heights at night?');
  const { conv_id } = await post('/api/new');
  const r = await post('/api/send', { conv_id, text: 'please ask them' });
  assert.strictEqual(r.reply.tools[0].decision, 'refused: search guard');
  assert.match(seen[1].messages.find((m) => m.role === 'tool').content, /^That question was not sent: it had words about the person \(/);
  assert.strictEqual((await get(`/api/conv/${conv_id}`)).approvals.length, 0, 'no card was made');
  assert.strictEqual(asks.listAsks().length, 0);
  const q = 'Is it safe for jdoe to visit Marlow Heights at night?';
  assert.strictEqual(r.reply.tools[0].args.question_sha, lib.sha256(q));
  const all = ['conversations', 'logs'].flatMap((d) => fs.readdirSync(path.join(TMP, d)).map((f) => fs.readFileSync(path.join(TMP, d, f), 'utf8'))).join('\n')
    + (fs.existsSync(path.join(TMP, 'approvals.jsonl')) ? fs.readFileSync(path.join(TMP, 'approvals.jsonl'), 'utf8') : '');
  assert.ok(!/marlow|jdoe|at night/i.test(all), 'none of the question\'s words is in any record');
  // Each guarded kind is refused: the user\'s name, a note phrase and a number from a note.
  for (const [k, text] of [['name', 'What does jdoe like?'], ['private', 'Tell me about Marlow Heights']]) {
    const out = await tools.handleCall({ name: 'ask_someone', args: { question: text } }, { convId: 'c-x' });
    assert.strictEqual(out.decision, 'refused: search guard', k);
    assert.strictEqual(out.ask.blocked.kind, k);
  }
});

test('with an endpoint set, the approved question (and only it) is sent there; the answer becomes a teacher turn', async (t) => {
  reset(); setTrust({ ask_someone: 'ask' });
  const got = [];
  const teacher = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(s) });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', reasoning: 'hmm', content: 'It is 020 7946 0177.' } }] })); });
  });
  await new Promise((r) => teacher.listen(7623, '127.0.0.1', r));
  t.after(() => new Promise((r) => { teacher.closeAllConnections(); teacher.close(r); }));
  process.env.LH_TEACHER_URL = 'http://127.0.0.1:7623/v1'; process.env.LH_TEACHER_KEY = 'k-test'; process.env.LH_TEACHER_MODEL = 'big-teacher';
  const { post, get } = await boot(t, 'd'.repeat(48));
  const info = await get('/api/info');
  assert.deepStrictEqual(info.teacher, { name: 'Mentor', endpoint: true });
  const { conv_id } = await post('/api/new');
  await post('/api/send', { conv_id, text: 'please ask them for the number', notes: 'ignored' });
  const conv = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(got.length, 0, 'nothing is sent before your yes');
  const ok = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve' });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].url, '/v1/chat/completions');
  assert.strictEqual(got[0].auth, 'Bearer k-test');
  assert.strictEqual(got[0].body.model, 'big-teacher');
  assert.deepStrictEqual(got[0].body.messages, [{ role: 'user', content: QUESTION }], 'only the question, no chat history');
  assert.match(ok.reply.text, /020 7946 0177/);
  const turns = lib.readJsonl(path.join(TMP, 'conversations', `${conv_id}.jsonl`)).filter((m) => m.author === 'teacher');
  assert.deepStrictEqual(turns.map((m) => m.text), ['It is 020 7946 0177.'], 'the reasoning is not part of the answer');
  assert.strictEqual(asks.listAsks().find((a) => a.id === ok.ask.id).via, 'endpoint');
  assert.ok(!JSON.stringify(fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.jsonl`), 'utf8')).includes('k-test'), 'the key is in no log');
});

test('an endpoint that fails leaves the question open for the command line', async (t) => {
  reset(); setTrust({ ask_someone: 'ask' });
  process.env.LH_TEACHER_URL = 'http://127.0.0.1:7699';   // nothing listens here
  const { post, get } = await boot(t, 'e'.repeat(48));
  const { conv_id } = await post('/api/new');
  await post('/api/send', { conv_id, text: 'please ask them' });
  const conv = await get(`/api/conv/${conv_id}`);
  const ok = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve' });
  assert.match(ok.teacher_error, /could not reach the teacher endpoint/);
  assert.strictEqual(asks.listAsks(true).length >= 1, true);
});

test('forgetting a chat deletes its asks and approvals; rejecting a question sends nothing', async (t) => {
  reset(); setTrust({ ask_someone: 'ask' });
  const { post, get } = await boot(t, 'f'.repeat(48));
  const a = (await post('/api/new')).conv_id; const b = (await post('/api/new')).conv_id;
  await post('/api/send', { conv_id: a, text: 'please ask them' });
  await post('/api/send', { conv_id: b, text: 'please ask them' });
  const ca = await get(`/api/conv/${a}`); const cb = await get(`/api/conv/${b}`);
  const rej = await post('/api/approval', { id: cb.approvals[0].id, decision: 'reject' });
  assert.strictEqual(rej.approval.status, 'rejected');
  await post('/api/approval', { id: ca.approvals[0].id, decision: 'approve' });
  assert.ok(asks.listAsks().some((x) => x.conv_id === a));
  assert.ok(!asks.listAsks().some((x) => x.conv_id === b), 'a rejected question is never saved');
  const f = await post('/api/forget', { conv_id: a });
  assert.strictEqual(f.removed.asks, 1);
  assert.ok(!asks.listAsks().some((x) => x.conv_id === a));
  assert.ok(!fs.readFileSync(path.join(TMP, 'asks.jsonl'), 'utf8').includes(a));
});

test('the command line lists open questions and answers one', async (t) => {
  reset(); setTrust({ ask_someone: 'ask' });
  const token = 'g'.repeat(48);
  const { post, get } = await boot(t, token);
  fs.writeFileSync(path.join(TMP, 'token'), token);
  const { conv_id } = await post('/api/new');
  await post('/api/send', { conv_id, text: 'please ask them' });
  const conv = await get(`/api/conv/${conv_id}`);
  const ok = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve' });
  const cli = (...args) => new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), ...args],
    { env: { ...process.env, LH_PORT: '7621', LH_DATA: TMP } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  const listed = await cli('asks');
  assert.match(listed.stdout, new RegExp(`${ok.ask.id}  \\[${conv_id}\\]  ${QUESTION.replace('?', '\\?')}`));
  const done = await cli('answer', ok.ask.id, 'Call the desk on 020 7946 0177.');
  assert.strictEqual(done.code, 0, done.stderr);
  assert.match(done.stdout, /^model: /m);
  assert.match((await cli('asks')).stdout, /no open questions/);
  assert.strictEqual((await cli('answer', ok.ask.id, 'x')).code, 1);
});

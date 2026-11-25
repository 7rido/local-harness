// node --test test
// No model: a fake OpenAI-compatible server stands in for the real one.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7391';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7392';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json'); // tests never touch a real trust.json
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt'); // tests run without a system prompt

const lib = require('../src/lib');
const { makeServer } = require('../src/server');

const JSON_HEAD = { 'content-type': 'application/json', connection: 'close' };
// A fake model server: GET answers /v1/models, POST goes to `handle(body)` which returns a chat message.
function fakeModel(handle) {
  return http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, JSON_HEAD); return res.end('{"data":[{"id":"fake-model"}]}'); }
      const message = handle(JSON.parse(s));
      res.writeHead(200, JSON_HEAD);
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 50 }, choices: [{ finish_reason: 'stop', message }] }));
    });
  });
}
const close = (x) => { x.closeAllConnections(); return new Promise((r) => x.close(r)); };

test('user turns are plain, tool results are labelled, and pasted text is marked', () => {
  const user = { author: 'user', text: 'hi' };
  const model = { author: 'model', text: 'hello' };
  assert.deepStrictEqual(lib.buildModelMessages([user, model]), [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' },
  ]);
  assert.deepStrictEqual(lib.buildModelMessages([{ author: 'user', text: 'Read this: A B C. Thoughts?', pasted: ['A B C.'] }]),
    [{ role: 'user', content: 'Read this: [pasted text]\nA B C.\n[end of pasted text] Thoughts?' }]);
  const tool = { author: 'tool', text: 'run_python\n→ 42' };
  assert.deepStrictEqual(lib.buildModelMessages([user, model, user, tool]), [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'hi\n\nTool result: run_python\n→ 42' },
  ]);
  const m = lib.makeMessage({ convId: 'c-x', author: 'user', text: 'hello' });
  assert.strictEqual(m.source, 'user');
  assert.throws(() => lib.makeMessage({ convId: 'c-x', author: 'someone-else', text: 'hello' }), /unknown author/);
});

test('an empty reply never goes back into the context', () => {
  const msgs = lib.buildModelMessages([
    { author: 'user', text: 'q1' }, { author: 'model', text: '' }, { author: 'user', text: 'q2' },
  ]);
  assert.deepStrictEqual(msgs, [{ role: 'user', content: 'q1\n\nq2' }]);
});

test('check-this flags catch numbers, doses, links and sensitive topics', () => {
  const r = lib.checkFlags('Call the crisis line at 1-800-2222 or 911. Two 20mg tablets is 40 mg. See opendepression.org.');
  const types = r.flags.map((f) => `${f.type}:${f.match}`);
  assert.ok(types.includes('number:1-800-2222'));
  assert.ok(types.includes('number:911'));
  assert.ok(types.includes('dose:20mg') && types.includes('dose:40 mg'));
  assert.ok(types.includes('link:opendepression.org'));
  assert.strictEqual(r.sensitive, true);
  const plain = lib.checkFlags('17 × 24 = 408. Canberra became the capital in 1927. 9mm: 350-400 fps. 1 2 3 4 5 6 7 8 9 10.');
  assert.deepStrictEqual(plain.flags, []);
  const text = lib.checkFlags('Crisis Text Line: Text HOME to 74174.');
  assert.ok(text.flags.some((f) => f.match === '74174'));
  const more = lib.checkFlags('Take two tablets now, or 3 pills later. Email help@clinic.example.org or call +44 20 7946 0958.');
  const m = more.flags.map((f) => `${f.type}:${f.match}`);
  assert.ok(m.includes('dose:two tablets') && m.includes('dose:3 pills'), m.join());
  assert.ok(m.includes('email:help@clinic.example.org'), m.join());
  assert.ok(m.some((x) => x.startsWith('number:+44')), m.join());
  assert.ok(!m.some((x) => x.startsWith('link:') && x.includes('example.org')), 'email not double-counted as link');
  // Low mood and crisis phrases make a question sensitive on their own.
  for (const q of ['i feel low', "I've been feeling really low for weeks and I can't sleep", 'everything feels hopeless',
    "I can't go on", 'I want to hurt myself', 'I want to die']) {
    assert.strictEqual(lib.checkFlags(q).sensitive, true, q);
  }
  assert.strictEqual(lib.checkFlags('the temperature will feel low tonight? no: the bridge is 40 m long').sensitive, true,
    'over-flagging accepted');
  assert.strictEqual(lib.checkFlags('What is 17 × 24?').sensitive, false);
  assert.strictEqual(plain.sensitive, false);
});

test('tool calls are found in parsed tool_calls and in raw text inside the thinking', () => {
  const tools = require('../src/tools');
  const parsed = tools.findCall({ tool_calls: [{ function: { name: 'run_python', arguments: '{"code":"print(2+2)"}' } }] });
  assert.deepStrictEqual(parsed, { name: 'run_python', args: { code: 'print(2+2)' }, raw: false });
  const raw = tools.findCall({ reasoning: 'let me check\n<tool_call>\n<function=run_python>\n<parameter=code>\nprint(17*24)\n</parameter>\n</function>\n</tool_call>' });
  assert.strictEqual(raw.name, 'run_python');
  assert.strictEqual(raw.args.code, 'print(17*24)');
  assert.strictEqual(tools.findCall({ content: 'no tools here' }), null);
});

test('an unknown tool is refused, and the model is told so', async () => {
  const tools = require('../src/tools');
  const unknown = await tools.handleCall({ name: 'send_email', args: {} });
  assert.match(unknown.decision, /refused/);
});

test('the shipped trust file turns the risky tools off, and a bad value falls back to the default', () => {
  const tools = require('../src/tools');
  const trust = require('../src/trust');
  const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trust.example.json'), 'utf8'));
  assert.deepStrictEqual({ ...example, search_never_send: undefined }, { current_time: 'on', search_chats: 'on', web_search: 'off', web_fetch: 'off',
    run_python: 'off', memory: 'off', search_never_send: undefined });
  for (const v of Object.values(example)) assert.ok(Array.isArray(v) || ['off', 'ask', 'on'].includes(v));
  // No trust file at all: the same safe defaults.
  assert.strictEqual(trust.level('run_python'), 'off');
  assert.deepStrictEqual(tools.offeredSchemas().map((s) => s.function.name).sort(), ['current_time', 'search_chats']);
  fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ run_python: 'sandboxed', web_search: 'on', web_fetch: 'maybe' }));
  assert.strictEqual(trust.level('run_python'), 'off', 'an unknown word is not "on"');
  assert.strictEqual(trust.level('web_fetch'), 'off');
  assert.strictEqual(trust.level('web_search'), 'on');
  fs.unlinkSync(process.env.LH_TRUST_FILE);
});

test('run_python runs in a Docker container only: never on the host, and with no Docker it fails', async () => {
  const tools = require('../src/tools');
  const args = tools.dockerArgs('lh-py-test');
  for (const flag of ['--network', 'none', '--read-only', '--cap-drop', 'ALL', '--memory', '--pids-limit', '--rm']) assert.ok(args.includes(flag), flag);
  assert.ok(!args.some((a) => /^-v|--volume|--mount/.test(a)), 'nothing of the host is mounted');
  const prev = process.env.LH_DOCKER;
  process.env.LH_DOCKER = path.join(TMP, 'no-such-docker');
  try {
    const r = await tools.runPythonSandboxed('print("ran on the host")');
    assert.strictEqual(r.ok, false);
    assert.match(r.output, /needs Docker; nothing was run/);
    assert.ok(!r.output.includes('ran on the host'));
  } finally { if (prev === undefined) delete process.env.LH_DOCKER; else process.env.LH_DOCKER = prev; }
});

test('tool loop: the model calls run_python, gets the output, then answers; all logged', async (t) => {
  const tools = require('../src/tools');
  const realRun = tools.TOOLS.run_python.run;
  tools.TOOLS.run_python.run = async (args) => ({ output: args.code.includes('17*24') ? '408' : '?', ok: true, seconds: 0.1 });
  fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ run_python: 'on' }));
  const seen = [];
  const fake = fakeModel((body) => {
    seen.push(body);
    return body.messages.some((m) => m.role === 'tool')
      ? { role: 'assistant', content: '17 × 24 = 408.' }
      : { role: 'assistant', reasoning: 'I should check.', content: '',
        tool_calls: [{ type: 'function', function: { name: 'run_python', arguments: '{"code":"print(17*24)"}' } }] };
  });
  await new Promise((r) => fake.listen(7392, '127.0.0.1', r));
  const token = 'b'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(async () => { tools.TOOLS.run_python.run = realRun; try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} await close(fake); await close(srv); });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const { conv_id } = await (await fetch('http://127.0.0.1:7391/api/new', { method: 'POST', headers: H })).json();
  const r = await (await fetch('http://127.0.0.1:7391/api/send', { method: 'POST', headers: H,
    body: JSON.stringify({ conv_id, text: 'What is 17 × 24?' }) })).json();
  assert.strictEqual(r.reply.text, '17 × 24 = 408.');
  assert.strictEqual(r.reply.tools.length, 1);
  assert.strictEqual(r.reply.tools[0].decision, 'ran');
  assert.match(r.reply.first_move, /^reached for run_python first \(ran\)/);
  assert.strictEqual(seen.length, 2);
  assert.ok(seen[0].tools.some((x) => x.function.name === 'run_python'), 'tool offered');
  const toolMsg = seen[1].messages.find((m) => m.role === 'tool');
  assert.strictEqual(toolMsg.content, '408');
  const md = fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.md`), 'utf8');
  assert.match(md, /Reached for `run_python`/);
});

test('with run_python off (the default) the model is not offered it, and a call is refused', async (t) => {
  const tools = require('../src/tools');
  const seen = [];
  const fake = fakeModel((body) => {
    seen.push(body);
    return body.tools ? { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'run_python', arguments: '{"code":"print(1)"}' } }] }
      : { role: 'assistant', content: 'I could not run it.' };
  });
  await new Promise((r) => fake.listen(7392, '127.0.0.1', r));
  const token = 'g'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(async () => { await close(fake); await close(srv); });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const { conv_id } = await (await fetch('http://127.0.0.1:7391/api/new', { method: 'POST', headers: H })).json();
  const r = await (await fetch('http://127.0.0.1:7391/api/send', { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: 'Run something' }) })).json();
  assert.ok(!seen[0].tools.some((x) => x.function.name === 'run_python'));
  assert.strictEqual(r.reply.tools[0].decision, 'refused: trust level is off');
  assert.strictEqual((await tools.handleCall({ name: 'run_python', args: { code: 'print(1)' } })).ok, false);
});

test('stuck on a tool: identical retries are skipped, then a final turn without tools', async (t) => {
  const tools = require('../src/tools');
  const realRun = tools.TOOLS.run_python.run;
  fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ run_python: 'on' }));
  let runs = 0;
  tools.TOOLS.run_python.run = async () => { runs += 1; return { output: 'TypeError', ok: false, seconds: 0 }; };
  const seen = [];
  const fake = fakeModel((body) => {
    seen.push(body);
    return body.tools
      ? { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'run_python',
        arguments: JSON.stringify({ code: 'import socket\nsocket.socket().connect(("example.com", 80), 5)' }) } }] }
      : { role: 'assistant', content: "I can't check that from here: the sandbox has no internet." };
  });
  await new Promise((r) => fake.listen(7392, '127.0.0.1', r));
  const token = 'c'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(async () => { tools.TOOLS.run_python.run = realRun; try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} await close(fake); await close(srv); });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const { conv_id } = await (await fetch('http://127.0.0.1:7391/api/new', { method: 'POST', headers: H })).json();
  const r = await (await fetch('http://127.0.0.1:7391/api/send', { method: 'POST', headers: H,
    body: JSON.stringify({ conv_id, text: 'Is example.com up?' }) })).json();
  assert.strictEqual(runs, 1, 'identical code runs only once');
  assert.deepStrictEqual(r.reply.tools.map((x) => x.decision),
    // Only runs count toward the limit; all attempts are capped at 5.
    ['ran', 'refused: same code as before', 'refused: same code as before', 'refused: same code as before', 'refused: same code as before', 'refused: too many refused calls']);
  assert.match(r.reply.tools[0].output, /no internet/);
  assert.strictEqual(r.reply.text, "I can't check that from here: the sandbox has no internet.");
  assert.ok(!('tools' in seen[seen.length - 1]), 'final turn offers no tools');
});

test('current_time reads the clock and runs at the "on" level', async () => {
  const tools = require('../src/tools');
  const txt = tools.currentTimeText(new Date('2026-11-10T06:52:00Z'));
  assert.match(txt, /2026/);
  assert.match(txt, /UTC 2026-11-10T06:52:00Z/);
  const out = await tools.handleCall({ name: 'current_time', args: {} });
  assert.strictEqual(out.decision, 'ran');
  assert.ok(tools.offeredSchemas().some((s) => s.function.name === 'current_time'));
});

test('how the model knows it: sentences are marked from what the harness can observe', () => {
  const r = lib.markReply(
    "17 × 24 = 408. Your deadline is the 14th, as you said. Call the crisis line at 1-800-2222. I don't know what time it is. Paris is the capital of France. I'm 90% sure.",
    [{ decision: 'ran', ok: true, output: '408' }], ['My deadline is the 14th.']);
  assert.deepStrictEqual(r.sentences.map((x) => x.mark), ['checked', 'told', 'unverified', 'unsure', 'unchecked', 'unchecked']);
  assert.strictEqual(r.stated_confidence, 90);
  assert.deepStrictEqual(lib.markReply("You're welcome! Anything else? Paris is in France.").sentences.map((x) => x.mark),
    [null, null, 'unchecked'], 'pleasantries and questions carry no mark');
  const note = 'You are a local assistant called Atlas, built by the Example Lab. You have no web search, no live data and no clock.';
  const fromNote = lib.markReply('I was built by the Example Lab as a local assistant. I have no live data or web search. Paris is in France.', [], [], note);
  assert.deepStrictEqual(fromNote.sentences.map((x) => x.mark), ['prompt', 'prompt', 'unchecked']);
  const noTool = lib.markReply('17 × 24 = 408.', [{ decision: 'refused: trust level is off', output: '408' }], []);
  assert.strictEqual(noTool.sentences[0].mark, 'unchecked', 'a refused tool call checks nothing');
});

test('when the model server is not running, the message is kept and the reply says why', async (t) => {
  const token = 'd'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(() => close(srv));
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const { conv_id } = await (await fetch('http://127.0.0.1:7391/api/new', { method: 'POST', headers: H })).json();
  const r = await (await fetch('http://127.0.0.1:7391/api/send', { method: 'POST', headers: H,
    body: JSON.stringify({ conv_id, text: 'Are you there?' }) })).json();
  assert.strictEqual(r.reply, undefined);
  assert.match(r.failed.reason, /model server is not reachable at http:\/\/127\.0\.0\.1:7392/);
  const conv = await (await fetch(`http://127.0.0.1:7391/api/conv/${conv_id}`, { headers: H })).json();
  assert.strictEqual(conv.messages.length, 1, 'the message is saved');
  assert.match(conv.failed.reason, /not reachable/);
  const info = await (await fetch('http://127.0.0.1:7391/api/info', { headers: H })).json();
  assert.strictEqual(info.model_up, false);
});

test('arithmetic slips: only a lone wrong sum is judged', () => {
  assert.deepStrictEqual(lib.arithmeticSlips('17 × 24 = 418. And 2 + 2 = 4.'), [{ expr: '17 × 24', claimed: '418', actual: '408' }]);
  assert.deepStrictEqual(lib.arithmeticSlips('17*20 + 17*3 = 340 + 51 = 391'), [], 'chains are not judged');
  assert.deepStrictEqual(lib.arithmeticSlips('180 / 2.5 = 72 and 10 / 4 = 2.5'), []);
});

test('approval flow: a tool at "ask" waits for the user, then runs when approved', async (t) => {
  const tools = require('../src/tools');
  const realRun = tools.TOOLS.run_python.run;
  tools.TOOLS.run_python.run = async () => ({ output: '408', ok: true, seconds: 0 });
  fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ run_python: 'ask' }));
  const fake = fakeModel((body) => {
    const last = body.messages[body.messages.length - 1];
    return /Tool result/.test(last.content || '')
      ? { role: 'assistant', content: 'It is 408.' }
      : { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'run_python', arguments: '{"code":"print(17*24)"}' } }] };
  });
  await new Promise((r) => fake.listen(7392, '127.0.0.1', r));
  const token = 'e'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(async () => { tools.TOOLS.run_python.run = realRun; try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} await close(fake); await close(srv); });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const post = async (route, body) => (await fetch('http://127.0.0.1:7391' + route, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json();
  const { conv_id } = await post('/api/new');
  const r1 = await post('/api/send', { conv_id, text: 'What is 17 × 24?' });
  assert.strictEqual(r1.reply.tools[0].decision, 'waiting for approval');
  const conv = await (await fetch(`http://127.0.0.1:7391/api/conv/${conv_id}`, { headers: H })).json();
  assert.strictEqual(conv.approvals.length, 1);
  const r2 = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve' });
  assert.strictEqual(r2.reply.text, 'It is 408.');
  const after = await (await fetch(`http://127.0.0.1:7391/api/conv/${conv_id}`, { headers: H })).json();
  assert.ok(after.messages.some((m) => m.author === 'tool' && m.source === 'tool'));
  assert.strictEqual(after.approvals.length, 0);
  // A second call waits again: "ask" never turns into "on" by itself.
  const r3 = await post('/api/send', { conv_id, text: 'And again: 17 × 24?' });
  assert.strictEqual(r3.reply.tools[0].decision, 'waiting for approval');
  const forgot = await post('/api/forget', { conv_id });
  assert.strictEqual(forgot.forgotten, conv_id);
  assert.strictEqual((await fetch(`http://127.0.0.1:7391/api/conv/${conv_id}`, { headers: H })).status, 404);
});

test('a rejected approval runs nothing and asks for no reply', async (t) => {
  const tools = require('../src/tools');
  const realRun = tools.TOOLS.run_python.run;
  let ran = 0;
  tools.TOOLS.run_python.run = async () => { ran += 1; return { output: 'x', ok: true, seconds: 0 }; };
  fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ run_python: 'ask' }));
  let calls = 0;
  const fake = fakeModel(() => { calls += 1; return { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'run_python', arguments: '{"code":"print(1)"}' } }] }; });
  await new Promise((r) => fake.listen(7392, '127.0.0.1', r));
  const token = 'h'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(async () => { tools.TOOLS.run_python.run = realRun; try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} await close(fake); await close(srv); });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const post = async (route, body) => (await fetch('http://127.0.0.1:7391' + route, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json();
  const { conv_id } = await post('/api/new');
  await post('/api/send', { conv_id, text: 'Run it' });
  const before = calls;
  const conv = await (await fetch(`http://127.0.0.1:7391/api/conv/${conv_id}`, { headers: H })).json();
  const out = await post('/api/approval', { id: conv.approvals[0].id, decision: 'reject' });
  assert.strictEqual(out.approval.status, 'rejected');
  assert.strictEqual(ran, 0);
  assert.strictEqual(calls, before, 'the model is not asked again');
});

test('no system prompt unless the user wrote one', () => {
  assert.strictEqual(lib.buildModelMessages([{ author: 'user', text: 'x' }])[0].role, 'user');
  assert.strictEqual(lib.buildModelMessages([{ author: 'user', text: 'x' }], 'Be kind.')[0].role, 'system');
  assert.strictEqual(lib.systemPrompt(), '', 'nothing is read from anywhere by default');
});

test('splitReply handles the reasoning field, reasoning_content, think tags and cut-off replies', () => {
  assert.deepStrictEqual(lib.splitReply({ message: { reasoning: 'r', content: 'a' }, finish_reason: 'stop' }),
    { thinking: 'r', text: 'a', finished: true, finishReason: 'stop', answerInThinking: false });
  assert.deepStrictEqual(lib.splitReply({ message: { reasoning_content: 'r2', content: 'a' }, finish_reason: 'stop' }),
    { thinking: 'r2', text: 'a', finished: true, finishReason: 'stop', answerInThinking: false });
  assert.deepStrictEqual(lib.splitReply({ message: { content: 'hmm</think>\n\n4' }, finish_reason: 'stop' }),
    { thinking: 'hmm', text: '4', finished: true, finishReason: 'stop', answerInThinking: false });
  const cut = lib.splitReply({ message: { content: '<think>still going' }, finish_reason: 'length' });
  assert.strictEqual(cut.finished, false);
  assert.strictEqual(cut.text, '');
  assert.strictEqual(lib.firstMove(cut), 'cut off while thinking (no answer)');
  assert.strictEqual(lib.firstMove({ thinking: 't', text: 'a', finished: true }), 'thought, then answered');
  // Thinking never closed, not cut off: what the model wrote is shown as its reply, marked.
  const unclosed = lib.splitReply({ message: { reasoning: 'The answer is 391.', content: null }, finish_reason: 'stop' });
  assert.strictEqual(unclosed.text, 'The answer is 391.');
  assert.strictEqual(unclosed.answerInThinking, true);
  assert.strictEqual(lib.firstMove(unclosed), 'answered inside its thinking (never closed it)');
});

test('skipFacts: only on skipped thinking, and only facts the harness can see', () => {
  const history = [
    { author: 'user', text: 'hi' }, { author: 'model', text: 'hello', first_move: 'answered without thinking' },
    { author: 'user', text: 'Which is bigger, 9.11 or 9.9? And how sure are you, from 0 to 100?' },
  ];
  const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: '…' }];
  const facts = lib.skipFacts({ thinking: '', text: '9.9', finished: true }, { history, systemPrompt: '', messages, contextTokens: 120 });
  assert.deepStrictEqual(facts, [
    'no system prompt in this chat',
    '1 earlier reply of the model in context, sent without their thinking',
    'skipped thinking 1 time earlier in this chat',
    'answering the user (66 characters)',
    'carrying 120 tokens',
  ]);
  assert.strictEqual(lib.skipFacts({ thinking: '', text: 'x' }, { systemPrompt: 'be brief', history: [{ author: 'user', text: 'hi' }] })[0], 'a system prompt was in place');
  assert.deepStrictEqual(lib.skipFacts({ thinking: 't', text: 'a' }, { history }), []);
  assert.deepStrictEqual(lib.skipFacts({ thinking: 'a', text: 'a', answerInThinking: true }, { history }), []);
  const md = lib.renderLogMarkdown('c', [{ type: 'reply', skip_facts: facts, first_move: 'answered without thinking', finished: true, seconds: 1, text: '9.9' }]);
  assert.match(md, /Skipped thinking\.\*\* What the harness saw: no system prompt/);
});

test('end to end: a chat, a readable log, sampling recorded, only the user can post', async (t) => {
  const seen = [];
  const fake = fakeModel((body) => {
    seen.push(body);
    return { role: 'assistant', reasoning: 'let me check', content: 'It is 40.' };
  });
  await new Promise((r) => fake.listen(7392, '127.0.0.1', r));
  const token = 'a'.repeat(48);
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7391, '127.0.0.1', r));
  t.after(async () => { await close(fake); await close(srv); });

  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const url = (p) => `http://127.0.0.1:7391${p}`;

  assert.strictEqual((await fetch(url('/api/info'))).status, 401, 'token required');
  assert.strictEqual((await fetch(url('/api/info') + '?t=' + token)).status, 200, 'the token also works as ?t=');
  // fetch ignores a custom Host header, so send it with a raw request.
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 7391, path: '/api/info',
      headers: { host: 'evil.example:7391', 'x-lh-token': token } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.strictEqual(badHost, 403, 'host checked');

  const { conv_id } = await (await fetch(url('/api/new'), { method: 'POST', headers: H })).json();
  const r1 = await (await fetch(url('/api/send'), { method: 'POST', headers: H,
    body: JSON.stringify({ conv_id, text: 'What is 4% of 1000?' }) })).json();
  assert.strictEqual(r1.reply.text, 'It is 40.');
  assert.strictEqual(r1.reply.thinking, 'let me check');
  assert.strictEqual(seen[0].messages[0].content, 'What is 4% of 1000?');
  assert.strictEqual(seen[0].stream, true);
  assert.ok(!('model' in seen[0]), 'no model name is sent unless LH_MODEL_NAME is set');
  assert.ok(!('top_k' in seen[0]), 'top_k is not sent unless asked for');
  assert.strictEqual(seen[0].temperature, 0.7);
  assert.strictEqual(seen[0].top_p, 0.95);
  assert.deepStrictEqual(r1.reply.sampling, { temperature: 0.7, top_p: 0.95 }, 'recorded with the reply');
  const callEv = lib.readJsonl(path.join(TMP, 'logs', `${conv_id}.jsonl`)).find((e) => e.type === 'model_call');
  assert.deepStrictEqual(callEv.sampling, { temperature: 0.7, top_p: 0.95 }, 'recorded in the log');
  assert.strictEqual(callEv.model.id, 'fake-model', 'the model name learned from /v1/models is logged');

  // reply: false saves the message without calling the model.
  await fetch(url('/api/send'), { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: 'Hold on.', reply: false }) });
  assert.strictEqual(seen.length, 1, 'no-reply does not call the model');
  await fetch(url('/api/send'), { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: 'Who is right?' }) });
  const last = seen[1].messages;
  assert.strictEqual(last[last.length - 1].content, 'Hold on.\n\nWho is right?');

  const conv = lib.readJsonl(path.join(TMP, 'conversations', `${conv_id}.jsonl`));
  assert.deepStrictEqual(conv.map((m) => m.source), ['user', 'model', 'user', 'user', 'model']);

  const md = fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.md`), 'utf8');
  assert.match(md, /not a guaranteed window/);
  assert.match(md, /\*\*First move:\*\* thought, then answered/);

  // Nobody can post as the model: whatever "author" says, the message is the user's.
  await fetch(url('/api/send'), { method: 'POST', headers: H, body: JSON.stringify({ conv_id, author: 'model', text: 'spoof', reply: false }) });
  const after = lib.readJsonl(path.join(TMP, 'conversations', `${conv_id}.jsonl`));
  assert.strictEqual(after[after.length - 1].author, 'user');
  const bad = await fetch(url('/api/send'), { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: '   ' }) });
  assert.strictEqual(bad.status, 400, 'an empty message is refused');
});

// node --test test
// Think harder: 8 tries, the model's own test inputs, a sandbox check of each try, the pick. The sandbox is a stub here: it
// reads the check script it is given and answers from markers in the tries' code, so the selection logic is tested without Docker.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-think-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7631';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7632';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');

const lib = require('../src/lib');
const th = require('../src/thinkharder');
const sandbox = require('../src/sandbox');
const { makeServer } = require('../src/server');

const PROMPT = 'Write is_prime(n) that returns True for primes. Also write a class Stack with push and pop. It should raise ValueError for bad input.';
const PLAIN = 'Write is_prime(n) that returns True for primes.';
const setTrust = (o) => fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify(o));
const reset = () => { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} };

// A stand-in for sandbox.run: finds the try's code in the check script, and answers from a marker in it.
//   # A / # B   every input gives the same output (aaaa / bbbb)      # CRASH   input 0 raises KeyError
//   # NOLOAD    the code fails to load                              # RAISE   input 0 raises ValueError (the task names it)
//   # FIXED     like A (a repaired try)
function stubRunner(log = []) {
  return async (script) => {
    const code = JSON.parse(script.match(/^SRC = (.*)$/m)[1]);
    const cases = JSON.parse(script.match(/^CASES = (.*)$/m)[1]);
    log.push({ code, cases });
    const lines = [];
    if (code.includes('# NOLOAD')) lines.push('@@TH LOADFAIL SyntaxError: invalid syntax');
    else {
      lines.push('@@TH LOADED');
      cases.forEach((c, i) => {
        if (code.includes('# CRASH') && i === 0) lines.push(`@@TH ${i} EXC KeyError: 'x'`);
        else if (code.includes('# RAISE') && i === 0) lines.push(`@@TH ${i} EXC ValueError: bad`);
        else lines.push(`@@TH ${i} OK ${code.includes('# B') ? 'bbbb0000bbbb0000' : 'aaaa0000aaaa0000'}`);
      });
      lines.push('@@TH DONE');
    }
    return { output: lines.join('\n'), ok: true, seconds: 0.1 };
  };
}
const reply = (text) => ({ text, finished: true });
const tryOf = (marker, pad = '') => reply(`Here you go:\n\`\`\`python\ndef is_prime(n):\n    return True  # ${marker}${pad}\n\`\`\``);
const choiceOf = (text, finish = 'stop') => ({ finish_reason: finish, message: { role: 'assistant', content: text } });

test('inputs: calls of a function the question names; salvaged from comparisons and asserts; wrappers and bare values are not inputs', () => {
  const text = [
    'Cases:', '```python', 'is_prime(7)', 'is_prime(1) == False', 'assert is_prime(2)', 'not is_prime(9)', 'print(is_prime(3))',
    'isinstance(is_prime(4), bool)', '7', 'other(3)', '# a comment', 'is_prime(7)', 'is_prime(11) should return True',
    '[s := Stack(), s.push(1), s.pop()][-1]', '[s := Stack(), s.pop()]', 'is_prime(5), 6, is_prime(8)', 'is_prime(0',
    '```',
  ].join('\n');
  assert.deepStrictEqual(th.parseInputs(reply(text), PROMPT), [
    'is_prime(7)', 'is_prime(1)', 'is_prime(2)', 'is_prime(9)', 'is_prime(11)',
    '[s := Stack(), s.push(1), s.pop()][-1]', '[s := Stack(), s.pop()]', 'is_prime(5)', 'is_prime(8)',
  ].slice(0, 8), 'at most 8, repeats dropped, only calls of named functions');
  assert.deepStrictEqual(th.parseInputs({ text: 'is_prime(2)', finished: false }, PROMPT), [], 'a reply that was cut off gives none');
  assert.deepStrictEqual(th.parseInputs(reply('no code here'), PROMPT), []);
  assert.strictEqual(th.isCall('Stack().push(1)', PROMPT), true);
  assert.strictEqual(th.isCall('len(x)', PROMPT), false);
});

test('the check script is valid for any code: it is passed as a string literal, and holds the alarm and the markers', () => {
  const code = 'def f():\n    return """a "quoted" \\n \\u00e9 \'x\'"""\n';
  const script = th.checkScript(code, ['f()', 'f(1)']);
  assert.strictEqual(JSON.parse(script.match(/^SRC = (.*)$/m)[1]), code);
  assert.deepStrictEqual(JSON.parse(script.match(/^CASES = (.*)$/m)[1]), ['f()', 'f(1)']);
  assert.ok(script.includes('signal.alarm(2)') && script.includes('"@@TH "') && !script.includes('__SECS__'));
});

test('the pick: the biggest group that agrees; ties go to the earlier try; the shortest reply stands for the group', async () => {
  const cases = ['is_prime(2)', 'is_prime(9)'];
  const replies = [tryOf('A', ' xx'), tryOf('B'), tryOf('A', ' x'), tryOf('A'), tryOf('B'), tryOf('CRASH'), reply('no code at all'), { text: tryOf('A').text, finished: false }];
  const sel = await th.selectCode(PROMPT, replies, cases, stubRunner());
  assert.deepStrictEqual(sel.survivors, [0, 1, 2, 3, 4], 'the crashing try, the one with no code and the cut-off one do not survive');
  assert.deepStrictEqual(sel.groups, [3, 2]);
  assert.strictEqual(sel.pick, 3, 'the shortest of the A group');
  assert.match(sel.why, /^biggest of 2 behaviour groups \(3 of 5\)$/);
  // A tie: the group holding the earlier try wins.
  const tie = await th.selectCode(PROMPT, [tryOf('B'), tryOf('A'), tryOf('B'), tryOf('A')], cases, stubRunner());
  assert.strictEqual(tie.pick, 0);
  // No inputs at all: the first try that loads.
  const none = await th.selectCode(PROMPT, [reply('x'), tryOf('NOLOAD'), tryOf('A')], [], stubRunner());
  assert.deepStrictEqual([none.pick, none.why], [2, 'first try that loads (no inputs)']);
});

test('a raise the question names is behaviour, not a crash; any other raise is a crash', async () => {
  const cases = ['is_prime(-1)', 'is_prime(3)'];
  const named = await th.selectCode(PROMPT, [tryOf('RAISE'), tryOf('RAISE'), tryOf('A')], cases, stubRunner());
  assert.deepStrictEqual(named.survivors, [0, 1, 2], 'ValueError is in the question');
  assert.deepStrictEqual(named.groups, [2, 1]);
  const crash = await th.selectCode('Write is_prime(n).', [tryOf('RAISE'), tryOf('A'), tryOf('A')], cases, stubRunner());
  assert.deepStrictEqual(crash.survivors, [1, 2], 'a raise the question does not mention is a crash');
  // An input whose call itself fails on every try is the model\'s bad input and is left out.
  const badRunner = async (script) => ({ output: '@@TH LOADED\n@@TH 0 EXC NameError: name \'helper\' is not defined\n@@TH 1 OK aaaa0000aaaa0000\n@@TH DONE', ok: true, seconds: 0 });
  const bad = await th.selectCode(PROMPT, [tryOf('A'), tryOf('A')], ['helper(is_prime(2))', 'is_prime(3)'], badRunner);
  assert.deepStrictEqual([bad.inputs_bad, bad.inputs_used, bad.survivors], [[0], [1], [0, 1]]);
});

test('think(): draws 8 tries and the inputs, picks, reports its stages; repair only when asked, only when none survived', async () => {
  let n = 0; const asked = [];
  const draw = async (messages) => {
    asked.push(messages);
    const last = messages[messages.length - 1].content;
    if (/write test inputs/i.test(last)) return choiceOf('```python\nis_prime(2)\nis_prime(9)\n```');
    if (/Your solution failed/.test(last)) return choiceOf(tryOf('FIXED').text);
    const markers = ['CRASH', 'CRASH', 'NOLOAD', 'CRASH', 'CRASH', 'CRASH', 'CRASH', 'NOLOAD'];
    return choiceOf(tryOf(markers[n++ % 8], ' '.repeat(n)).text);
  };
  const stages = [];
  const messages = [{ role: 'user', content: PLAIN }];
  const plain = await th.think({ messages, prompt: PLAIN, draw, runner: stubRunner(), repair: false, onProgress: (p) => stages.push(p.stage) });
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(asked.length, 9, '8 tries and one reply of test inputs');
  assert.deepStrictEqual([...new Set(stages)], ['tries', 'inputs', 'checking']);
  assert.deepStrictEqual(plain.survivors, [], 'every try crashed or did not load');
  assert.strictEqual(plain.repaired, false);
  assert.match(plain.choice.message.content, /CRASH|NOLOAD/, 'with none surviving, the first try with code is shown');
  // The inputs request is the conversation with the instruction added to the last user turn.
  assert.ok(asked[8].length === 1 && asked[8][0].content.startsWith(PLAIN) && /write test inputs/i.test(asked[8][0].content));
  assert.ok(asked[0] === messages && !asked.slice(0, 8).some((m) => /test inputs/.test(JSON.stringify(m))), 'the tries are plain replies to the question');

  n = 0; asked.length = 0; stages.length = 0;
  const fixed = await th.think({ messages, prompt: PLAIN, draw, runner: stubRunner(), repair: true, onProgress: (p) => stages.push(p.stage) });
  assert.strictEqual(asked.length, 10, 'one repair try');
  assert.ok(stages.includes('repair'));
  assert.deepStrictEqual([fixed.repaired, fixed.repair.survived, fixed.repair.from_try], [true, true, 0]);
  const rm = asked[9];
  assert.strictEqual(rm[rm.length - 2].role, 'assistant');
  assert.match(rm[rm.length - 1].content, /Test case:\nis_prime\(2\)\n\nWhat happened:\nKeyError: 'x'/, 'the repair note names the failing input and the error');
  assert.match(fixed.choice.message.content, /FIXED/);
  // Survivors present: the repair round is never asked for.
  n = 0; asked.length = 0;
  const ok = await th.think({ messages, prompt: PLAIN, repair: true, runner: stubRunner(),
    draw: async (m) => (/write test inputs/i.test(m[m.length - 1].content) ? choiceOf('is_prime(2)') : choiceOf(tryOf('A', ' '.repeat(n++)).text)) });
  assert.strictEqual(ok.survivors.length, 8);
  assert.strictEqual(ok.repair, null);
});

test('think() stops with a reason if the sandbox disappears while checking', async () => {
  const gone = async () => ({ output: 'the sandbox is not available (stub). Nothing was run.', ok: false, seconds: 0, unavailable: true });
  const r = await th.think({ messages: [{ role: 'user', content: PROMPT }], prompt: PROMPT, runner: gone,
    draw: async (m) => (/write test inputs/i.test(m[m.length - 1].content) ? choiceOf('is_prime(2)') : choiceOf(tryOf('A').text)) });
  assert.deepStrictEqual([r.ok, /sandbox stopped answering/.test(r.reason)], [false, true]);
});

test('the two instruction files are there, neutral, and editable', () => {
  const inputs = th.inputsInstruction(); const rep = th.repairInstruction();
  assert.match(inputs, /write test inputs/i);
  assert.ok(rep.includes('{case}') && rep.includes('{error}'));
  for (const t of [inputs, rep]) assert.ok(!new RegExp(['frozen', 'ex' + 'am', 'own' + 'er', 'fred' + 'p'].join('|'), 'i').test(t));
});

async function boot(t, token, handler) {
  const asked = [];
  const fake = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      if (req.method === 'GET') return res.end('{"data":[]}');
      const body = JSON.parse(s); asked.push(body);
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 5 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: handler(body, asked.length) } }] }));
    });
  });
  await new Promise((r) => fake.listen(7632, '127.0.0.1', r));
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7631, '127.0.0.1', r));
  const realAvail = sandbox.available; const realRun = sandbox.run;
  t.after(async () => { sandbox.available = realAvail; sandbox.run = realRun; reset(); for (const x of [fake, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const call = async (method, route, body) => { const r = await fetch('http://127.0.0.1:7631' + route, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  const until = async (fn) => { for (let i = 0; i < 200; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timed out'); };
  return { asked, call, until };
}

test('through the harness: off by default; on with a sandbox it picks the agreeing try, shows progress, and records what it did', async (t) => {
  reset();
  let n = 0;
  const { asked, call, until } = await boot(t, 'a'.repeat(48), (body) => {
    const last = body.messages[body.messages.length - 1].content;
    if (/write test inputs/i.test(last)) return '```python\nis_prime(2)\nis_prime(9)\n```';
    return tryOf(['A', 'B', 'A', 'A', 'B', 'CRASH', 'A', 'B'][n++ % 8], ' '.repeat(n)).text;
  });
  const { body: { conv_id } } = await call('POST', '/api/new');
  // Off: refused, the message is saved, the model is not asked.
  const off = await call('POST', '/api/send', { conv_id, text: PROMPT, think_harder: true });
  assert.strictEqual(off.status, 400);
  assert.match(off.body.error, /think harder is off/);
  assert.strictEqual(asked.length, 0);

  setTrust({ think_harder: 'on' });
  sandbox.available = async () => ({ ok: true });
  const log = []; sandbox.run = stubRunner(log);
  const info = (await call('GET', '/api/info')).body;
  assert.deepStrictEqual(info.think_harder, { on: true, repair: false });
  const started = await call('POST', '/api/send', { conv_id, text: PROMPT, think_harder: true, repair: true });
  assert.deepStrictEqual(started.body.think_harder, { started: true, repair: false }, 'repair stays off unless its own switch is on');
  const conv = await until(async () => { const c = (await call('GET', `/api/conv/${conv_id}`)).body; return c.messages.find((m) => m.author === 'model') ? c : null; });
  const m = conv.messages.find((x) => x.author === 'model');
  assert.strictEqual(asked.length, 9);
  assert.deepStrictEqual([m.think_harder.ran, m.think_harder.tries, m.think_harder.inputs, m.think_harder.survivors], [true, 8, 2, 7]);
  assert.match(m.think_harder.why, /^biggest of 2 behaviour groups \(4 of 7\)$/);
  assert.match(m.text, /# A/, 'the shown reply is a try from the agreeing group');
  assert.strictEqual(log.length, 8, 'each try was checked once in the sandbox');
  assert.deepStrictEqual(log[0].cases, ['is_prime(2)', 'is_prime(9)']);
  assert.strictEqual(conv.think_harder, null, 'the progress line is gone once the reply is saved');
  const ev = lib.readJsonl(path.join(TMP, 'logs', `${conv_id}.jsonl`)).find((e) => e.type === 'think_harder');
  assert.strictEqual(ev.result.reply_texts.length, 8, 'every try is in the activity log');
  assert.ok(ev.result.inputs.length === 2 && ev.result.select);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  for (const s of ['id="thinkbtn"', 'think_harder: true', 'function thinkText', 'function thinkNote']) assert.ok(html.includes(s), s);
});

test('with no Docker the reply is a normal one and says why', async (t) => {
  reset(); setTrust({ think_harder: 'on' });
  process.env.LH_DOCKER = path.join(TMP, 'no-such-docker');
  t.after(() => { delete process.env.LH_DOCKER; });
  const { asked, call, until } = await boot(t, 'b'.repeat(48), () => 'Just a plain answer.');
  const { body: { conv_id } } = await call('POST', '/api/new');
  await call('POST', '/api/send', { conv_id, text: PROMPT, think_harder: true });
  const conv = await until(async () => { const c = (await call('GET', `/api/conv/${conv_id}`)).body; return c.messages.find((m) => m.author === 'model') ? c : null; });
  const m = conv.messages.find((x) => x.author === 'model');
  assert.strictEqual(m.text, 'Just a plain answer.');
  assert.strictEqual(m.think_harder.ran, false);
  assert.match(m.think_harder.reason, /sandbox is not available.*docker command was not found/);
  assert.strictEqual(asked.length, 1, 'no tries were drawn');
});

test('with its repair switch on, a failed set of tries gets one repair', async (t) => {
  reset(); setTrust({ think_harder: 'on', think_harder_repair: 'on' });
  let n = 0;
  const { asked, call, until } = await boot(t, 'c'.repeat(48), (body) => {
    const last = body.messages[body.messages.length - 1].content;
    if (/write test inputs/i.test(last)) return '```python\nis_prime(2)\n```';
    if (/Your solution failed/.test(last)) return tryOf('FIXED').text;
    return tryOf('CRASH', ' '.repeat(n++)).text;
  });
  sandbox.available = async () => ({ ok: true }); sandbox.run = stubRunner();
  const { body: { conv_id } } = await call('POST', '/api/new');
  const s = await call('POST', '/api/send', { conv_id, text: PLAIN, think_harder: true, repair: true });
  assert.strictEqual(s.body.think_harder.repair, true);
  const conv = await until(async () => { const c = (await call('GET', `/api/conv/${conv_id}`)).body; return c.messages.find((m) => m.author === 'model') ? c : null; });
  const m = conv.messages.find((x) => x.author === 'model');
  assert.deepStrictEqual([m.think_harder.repair_on, m.think_harder.repaired], [true, true]);
  assert.match(m.text, /FIXED/);
  assert.strictEqual(asked.length, 10);
});

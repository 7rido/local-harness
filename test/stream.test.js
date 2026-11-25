// node --test test
// The reply is streamed so the page shows the thinking live.
// The saved records must be the same as when the model server sends the whole reply at once: a fake
// model server answers each case once as one JSON body and once as an mlx_lm-style event stream, cut
// into awkward pieces, and the conversation line and the reply event are compared.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-stream-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7431';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7432';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');

const { makeServer } = require('../src/server');
const { readCompletion } = require('../src/stream');

const H = { 'content-type': 'application/json', 'x-lh-token': 'b'.repeat(48) };
const BASE = 'http://127.0.0.1:7431';

// The non-stream body mlx_lm.server sends: content null when empty, reasoning only when there is some.
function whole({ reasoning = '', content = '', finish = 'stop', toolCalls = [], prompt = 50, completion = 20 }) {
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.map((t, i) => ({ function: t, type: 'function', id: `id-${i}` }));
  return { id: 'chatcmpl-x', system_fingerprint: 'fp', object: 'chat.completion', model: 'fake-model', created: 1,
    choices: [{ index: 0, finish_reason: finish, message }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: 3 } } };
}
// The same generation as mlx_lm.server streams it: a keepalive comment, the reasoning and the text in
// small pieces, the tool calls (with "index"), the chunk with finish_reason, the usage chunk, [DONE].
function sse(b, { truncate = false } = {}) {
  const m = b.choices[0].message;
  const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion.chunk', model: b.model, created: 1,
    choices: [{ index: 0, finish_reason: finish, delta: { role: 'assistant', ...delta } }] }) + '\n\n';
  let out = ': keepalive 10/50\n\n';
  const pieces = (s) => s.match(/[\s\S]{1,3}/gu) || [];
  for (const p of pieces(m.reasoning || '')) out += chunk({ reasoning: p });
  for (const p of pieces(m.content || '')) out += chunk({ content: p });
  if (m.tool_calls) out += chunk({ tool_calls: m.tool_calls.map((t, i) => ({ ...t, index: i })) });
  if (truncate) return out;
  out += chunk({}, b.choices[0].finish_reason);
  out += 'data: ' + JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', model: b.model, created: 1, choices: [], usage: b.usage }) + '\n\n';
  return out + 'data: [DONE]\n\n';
}

// A fake model server: each POST takes the next body from `script`, sent whole or as a stream in 5-byte
// pieces (so piece edges fall inside data lines and inside multi-byte characters).
async function fakeModel(t, script, mode) {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', async () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); return res.end('{"data":[]}'); }
      const reqBody = JSON.parse(s);
      const b = script[Math.min(n++, script.length - 1)];
      if (mode === 'json' || !reqBody.stream) { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); return res.end(JSON.stringify(b)); }
      assert.deepStrictEqual(reqBody.stream_options, { include_usage: true }, 'usage is asked for, so the records keep it');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
      const bytes = Buffer.from(sse(b, { truncate: mode === 'truncate' }));
      for (let i = 0; i < bytes.length; i += 5) { res.write(bytes.subarray(i, i + 5)); await new Promise((r) => setImmediate(r)); }
      res.end();
    });
  });
  await new Promise((r) => srv.listen(7432, '127.0.0.1', r));
  return srv;
}

async function runCase(t, script, mode) {
  const model = await fakeModel(t, script, mode);
  const srv = makeServer('b'.repeat(48));
  await new Promise((r) => srv.listen(7431, '127.0.0.1', r));
  try {
    const { conv_id } = await (await fetch(`${BASE}/api/new`, { method: 'POST', headers: H })).json();
    const r = await (await fetch(`${BASE}/api/send`, { method: 'POST', headers: H,
      body: JSON.stringify({ conv_id, text: 'What time is it, and what is 2 + 2?' }) })).json();
    const conv = lib.readJsonl(path.join(TMP, 'conversations', `${conv_id}.jsonl`));
    const log = lib.readJsonl(path.join(TMP, 'logs', `${conv_id}.jsonl`));
    return { r, conv, log, conv_id };
  } finally {
    for (const x of [model, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); }
  }
}
const lib = require('../src/lib');

// What may differ between two runs: ids, times, durations, the clock tool's output.
function mask(x) {
  return JSON.parse(JSON.stringify(x, (k, v) => {
    if (['id', 'ts', 'conv_id', 'message_id', 'seconds', 'created', 'messages_sha'].includes(k)) return '*';
    return v;
  }), (k, v) => (v && typeof v === 'object' && v.name === 'current_time' && 'output' in v ? { ...v, output: '*' }
    // The clock's answer also rides in the next logged request: two runs can straddle a minute.
    : v && typeof v === 'object' && v.role === 'tool' ? { ...v, content: '*' } : v));
}
function records(run) {
  return { reply: mask(run.conv.find((m) => m.author === 'model')),
    events: mask(run.log.filter((e) => ['reply', 'model_call', 'tool_attempt'].includes(e.type))) };
}

const CASES = {
  'thinking, then an answer (with characters of several bytes)': [
    whole({ reasoning: 'The user asks 2 + 2. Easy: 4 — café ✓ 🙂.', content: '\n\nIt is **4** — naïve check ✓ 🙂.' })],
  'cut off at the token limit while thinking': [
    whole({ reasoning: 'Let me think about this for a long time…', finish: 'length' })],
  'cut off while answering': [
    whole({ reasoning: 'Short thought.', content: 'The answer is', finish: 'length' })],
  'thinking never closed (all in content)': [
    whole({ content: '<think>\nI think the answer is 4, because 2 + 2 = 4.' })],
  'a parsed tool call, then a second step': [
    whole({ reasoning: 'I need the time.', toolCalls: [{ name: 'current_time', arguments: '{}' }], finish: 'tool_calls' }),
    whole({ reasoning: 'Now I have it.', content: 'It is now that time, and 2 + 2 = 4.' })],
  'a raw tool call in the text': [
    whole({ reasoning: 'Time first.', content: 'Checking.\n<tool_call>\n{"name": "current_time", "arguments": {}}\n</tool_call>' }),
    whole({ content: 'Done: 2 + 2 = 4.' })],
};

for (const [name, script] of Object.entries(CASES)) {
  test(`streamed and whole give the same records: ${name}`, async (t) => {
    const a = await runCase(t, script, 'json');
    const b = await runCase(t, script, 'sse');
    assert.ok(a.r.reply && b.r.reply, 'both replied');
    assert.deepStrictEqual(records(b), records(a));
    // And the live view is gone once the reply is saved.
    // (The route answers null when nothing is being written.)
  });
}

test('a stream that stops early is a failed call: nothing is saved as the reply', async (t) => {
  const run = await runCase(t, [whole({ reasoning: 'Half a thought', content: 'Half an ans' })], 'truncate');
  assert.ok(!run.r.reply, 'no reply');
  assert.match(run.r.failed.reason, /stopped before the reply was finished/);
  assert.ok(!run.conv.some((m) => m.author === 'model'), 'no partial reply in the conversation');
  const failed = run.log.find((e) => e.event === 'model call failed');
  assert.ok(failed);
  assert.strictEqual(failed.stream_end, 'closed cleanly by the server', 'the log says the server closed the stream itself, not a reset');
  assert.strictEqual(typeof failed.seconds_since_last_piece, 'number');
});

test('readCompletion also reads reasoning_content, as some servers name the field', async () => {
  const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ model: 'm', choices: [{ index: 0, finish_reason: finish, delta }] }) + '\n\n';
  const text = chunk({ reasoning_content: 'hmm ' }) + chunk({ reasoning_content: 'ok' }) + chunk({ content: 'Four.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
  const got = await readCompletion(new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
  assert.strictEqual(got.choices[0].message.reasoning, 'hmm ok');
  assert.strictEqual(got.choices[0].message.content, 'Four.');
});

test('readCompletion rebuilds the whole body from the stream', async () => {
  const b = whole({ reasoning: 'é'.repeat(7) + '🙂', content: 'ok ✓', toolCalls: [{ name: 'current_time', arguments: '{}' }], finish: 'tool_calls' });
  const bytes = Buffer.from(sse(b));
  const seen = [];
  const body = new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 1) c.enqueue(bytes.subarray(i, i + 1)); c.close(); } });
  const got = await readCompletion(new Response(body, { headers: { 'content-type': 'text/event-stream' } }), (d) => seen.push(d));
  const strip = (x) => { const y = JSON.parse(JSON.stringify(x)); for (const k of ['id', 'system_fingerprint', 'object', 'created']) delete y[k]; return y; };
  assert.deepStrictEqual(strip(got), strip(b));
  assert.strictEqual(seen.at(-1).reasoning, b.choices[0].message.reasoning, 'the live text grows to the whole thinking');
  assert.ok(seen.length > 3, 'the text arrives in pieces');
  // Cut off while thinking: no answer text, so content is null, as in the whole body.
  const cut = whole({ reasoning: 'still thinking', finish: 'length' });
  const got2 = await readCompletion(new Response(sse(cut), { headers: { 'content-type': 'text/event-stream' } }));
  assert.deepStrictEqual(strip(got2), strip(cut));
  assert.strictEqual(got2.choices[0].message.content, null);
});

test('while the model writes, the page can read its thinking so far; it is never logged', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const model = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', async () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); return res.end('{"data":[]}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      const head = 'data: ' + JSON.stringify({ model: 'fake-model', choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', reasoning: 'secretly-unique thinking so far' } }] }) + '\n\n';
      res.write(head);
      await gate;
      res.write('data: ' + JSON.stringify({ model: 'fake-model', choices: [{ index: 0, finish_reason: null, delta: { content: 'Four.' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ model: 'fake-model', choices: [{ index: 0, finish_reason: 'stop', delta: {} }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ model: 'fake-model', choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((r) => model.listen(7432, '127.0.0.1', r));
  const srv = makeServer('b'.repeat(48));
  await new Promise((r) => srv.listen(7431, '127.0.0.1', r));
  t.after(async () => { for (const x of [model, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const { conv_id } = await (await fetch(`${BASE}/api/new`, { method: 'POST', headers: H })).json();
  const sending = fetch(`${BASE}/api/send`, { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: '2 + 2?' }) }).then((r) => r.json());
  let live = null;
  for (let i = 0; i < 100 && !live; i++) { live = (await (await fetch(`${BASE}/api/conv/${conv_id}/live`, { headers: H })).json()).live; if (!live) await new Promise((r) => setTimeout(r, 20)); }
  assert.strictEqual(live.thinking, 'secretly-unique thinking so far');
  assert.strictEqual(live.text, '');
  assert.strictEqual((await (await fetch(`${BASE}/api/conv/${conv_id}`, { headers: H })).json()).writing, true);
  release();
  const r = await sending;
  assert.strictEqual(r.reply.text, 'Four.');
  assert.strictEqual(r.reply.thinking, 'secretly-unique thinking so far');
  assert.strictEqual((await (await fetch(`${BASE}/api/conv/${conv_id}/live`, { headers: H })).json()).live, null, 'cleared once saved');
  // The live text went nowhere but the page: the log has the saved reply's thinking once, in the reply event.
  const log = fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.jsonl`), 'utf8');
  assert.strictEqual(log.split('secretly-unique').length - 1, 1);
});

test('the live view needs the token', async (t) => {
  const srv = makeServer('b'.repeat(48));
  await new Promise((r) => srv.listen(7431, '127.0.0.1', r));
  t.after(async () => { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); });
  const { conv_id } = await (await fetch(`${BASE}/api/new`, { method: 'POST', headers: H })).json();
  assert.strictEqual((await fetch(`${BASE}/api/conv/${conv_id}/live`)).status, 401);
});

test('the page polls the live view and shows the thinking as it is written', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /'\/api\/conv\/' \+ id \+ '\/live'/);
  assert.match(html, /Thinking \(as it is written\)/);
  assert.match(html, /if \(busy \|\| r\.writing \|\| convThink\) startLive\(\)/, 'replies started from another window show live too');
  assert.match(html, /if \(busy \|\| convLive\) liveTimer = setTimeout\(liveTick, 700\);/);
  // The live start and end never force a redraw (an approval being edited is kept).
  assert.match(html, /else if \(convLive \|\| had\) await refresh\(\)\.catch/);
  assert.match(html, /JSON\.stringify\(r\.think_harder \|\| null\) \+ Boolean\(convLive\) \+ JSON\.stringify\(r\.failed \|\| null\);/);
});

// A blank reply after the tool limit: asked with no tools offered, a model can end in a tool call and say nothing;
// the chat would show a blank reply.
const toolCall = (r) => whole({ reasoning: r, toolCalls: [{ name: 'current_time', arguments: '{}' }], finish: 'tool_calls' });
const LIMIT = [toolCall('one'), toolCall('two'), toolCall('three'), toolCall('four')];

for (const mode of ['json', 'sse']) {
  test(`a blank reply after the tool limit is asked once more, and the answer is kept (${mode})`, async (t) => {
    // The blank try has no thinking of its own (with thinking, it shows as answered in its thinking).
    const run = await runCase(t, [...LIMIT, toolCall(''), whole({ reasoning: 'answer now', content: 'It is 4.' })], mode);
    assert.strictEqual(run.r.reply.text, 'It is 4.');
    assert.ok(!run.r.reply.blank_after_retry);
    assert.ok(run.log.some((e) => e.event === 'blank reply, asked once more'));
    const extra = run.log.filter((e) => e.type === 'tool_attempt' && e.step === 'retry');
    assert.strictEqual(extra.length, 1);
    assert.strictEqual(extra[0].decision, 'refused: tool limit reached');
    // The thinking from before the second ask stays in the record, with the new thinking after it.
    assert.match(run.r.reply.thinking, /four[\s\S]*answer now/);
    // The last request was well formed: the refused call got the limit message as its result.
    const calls = run.log.filter((e) => e.type === 'model_call');
    assert.strictEqual(calls.length, 6);
    const last = calls.at(-1);
    assert.deepStrictEqual(last.tools_offered, []);
    assert.match(last.messages.at(-1).content, /which is the limit/);
  });
}

test('still blank after the second ask: saved blank and marked for the page', async (t) => {
  const run = await runCase(t, [...LIMIT, toolCall(''), toolCall('')], 'sse');
  assert.strictEqual(run.r.reply.text, '');
  assert.strictEqual(run.r.reply.blank_after_retry, true);
  assert.strictEqual(run.log.find((e) => e.type === 'reply').blank_after_retry, true);
  assert.strictEqual(run.log.filter((e) => e.type === 'model_call').length, 6, 'asked once more, not again and again');
  // A blank reply never goes back into the context.
  assert.ok(!lib.buildModelMessages(run.conv, '').some((m) => m.role === 'assistant'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /if \(m\.blank_after_retry\)/);
});

test('a raw tool call inside the thinking alone is blank too: asked once more, and the markup is never shown', async (t) => {
  const raw = '<tool_call>\n<function=current_time>\n</function>\n</tool_call>';   // the raw form (tools.js RAW_CALL)
  const run = await runCase(t, [...LIMIT, whole({ reasoning: raw }), whole({ content: 'It is 4.' })], 'sse');
  assert.strictEqual(run.r.reply.text, 'It is 4.');
  assert.ok(run.log.some((e) => e.event === 'blank reply, asked once more'));
  assert.strictEqual(run.log.filter((e) => e.type === 'tool_attempt' && e.step === 'retry').length, 1);
  assert.ok(!/<tool_call>/.test(run.r.reply.thinking || ''));
  // Still only markup on the second ask: saved blank and marked, not shown as "answered in its thinking".
  const run2 = await runCase(t, [...LIMIT, whole({ reasoning: raw }), whole({ reasoning: raw })], 'json');
  assert.strictEqual(run2.r.reply.text, '');
  assert.strictEqual(run2.r.reply.blank_after_retry, true);
  assert.ok(!run2.r.reply.answer_in_thinking);
});

test('a reply the harness took raw tool-call markup out of is marked raw_call_removed; others are not', async (t) => {
  const raw = '<tool_call>\n<function=current_time>\n</function>\n</tool_call>';
  const marked = await runCase(t, [whole({ reasoning: `Let me check. ${raw}` }), whole({ content: 'It is 4.' })], 'json');
  assert.strictEqual(marked.r.reply.raw_call_removed, true);
  assert.strictEqual(marked.log.find((e) => e.type === 'reply').raw_call_removed, true);
  const plain = await runCase(t, [whole({ reasoning: 'easy', content: 'It is 4.' })], 'json');
  assert.ok(!('raw_call_removed' in plain.r.reply));
  assert.ok(!('raw_call_removed' in plain.log.find((e) => e.type === 'reply')));
});

test('the page uses no browser pop-ups (some embedded browser panes answer them Cancel unseen)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.ok(!/window\.(confirm|prompt|alert)\(|[^.\w](confirm|prompt|alert)\(/.test(html.replace(/function dialog[\s\S]*?const tell[^\n]*\n/, '')));
  // Boxes that cannot be undone start on Cancel: every Forget, and deleting a chat's notes or habits.
  assert.strictEqual((html.match(/await askDanger\(/g) || []).length, 5);
  assert.ok(!/await ask\('Forget/.test(html));
  assert.match(html, /\(ta \|\| \(danger && c\) \|\| ok\)\.focus\(\);/);
});

test('a reply that was cut off is not asked again', async (t) => {
  const run = await runCase(t, [whole({ reasoning: 'long', finish: 'length' }), whole({ content: 'never asked' })], 'json');
  assert.ok(!run.log.some((e) => e.event === 'blank reply, asked once more'));
  assert.strictEqual(run.log.filter((e) => e.type === 'model_call').length, 1);
});

// Only runs count toward the limit: a refused duplicate must not use up one of the three tries, or the retry the
// model needs would hit the limit.
test('a refused duplicate does not use up one of the three tool runs', async (t) => {
  const py = (code) => whole({ toolCalls: [{ name: 'current_time', arguments: JSON.stringify({ code }) }], finish: 'tool_calls' });
  const run = await runCase(t, [py('a'), py('a'), py('b'), py('c'), whole({ content: 'Done.' })], 'json');
  assert.deepStrictEqual(run.r.reply.tools.map((x) => x.decision), ['ran', 'refused: same code as before', 'ran', 'ran']);
  assert.strictEqual(run.r.reply.text, 'Done.');
  // A fourth run is refused with the limit message as before.
  const run2 = await runCase(t, [py('a'), py('b'), py('c'), py('d'), whole({ content: 'Done.' })], 'json');
  assert.deepStrictEqual(run2.r.reply.tools.map((x) => x.decision), ['ran', 'ran', 'ran', 'refused: tool limit reached']);
});

test('two early refusals do not end tool use before anything ran; five attempts in all', async (t) => {
  const py = (code) => whole({ toolCalls: [{ name: 'current_time', arguments: JSON.stringify({ code }) }], finish: 'tool_calls' });
  const run = await runCase(t, [py('a'), py('a'), py('a'), py('b'), py('c'), py('d'), whole({ content: 'Done.' })], 'json');
  assert.deepStrictEqual(run.r.reply.tools.map((x) => x.decision),
    ['ran', 'refused: same code as before', 'refused: same code as before', 'ran', 'ran', 'refused: tool limit reached']);
});

test('past five attempts the model reads the stop line', async (t) => {
  const py = (code) => whole({ toolCalls: [{ name: 'current_time', arguments: JSON.stringify({ code }) }], finish: 'tool_calls' });
  const run = await runCase(t, [py('a'), py('a'), py('a'), py('a'), py('a'), py('a'), whole({ content: 'Done.' })], 'json');
  assert.strictEqual(run.r.reply.tools.at(-1).decision, 'refused: too many refused calls');
  assert.strictEqual(run.r.reply.tools.at(-1).output, 'No more tools in this reply; answer with what you have, and say plainly what you could not check.');
});

// A connection that drops about a minute into a reply: the log must say why, and a drop before any text is retried once.
async function dropServer(t, plan) {
  let n = 0;
  const model = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); }
      const step = plan[Math.min(n++, plan.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (step === 'drop-before') return res.socket.destroy();
      if (step === 'drop-after') { res.write(sse(whole({ reasoning: 'half a thought' })).split('\n\n').slice(1, 3).join('\n\n') + '\n\n'); return setTimeout(() => res.socket.destroy(), 30); }
      res.end(sse(whole({ reasoning: 'ok', content: 'Here you are.' })));
    });
  });
  await new Promise((r) => model.listen(7432, '127.0.0.1', r));
  const srv = makeServer('b'.repeat(48));
  await new Promise((r) => srv.listen(7431, '127.0.0.1', r));
  t.after(async () => { for (const x of [model, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const { conv_id } = await (await fetch(`${BASE}/api/new`, { method: 'POST', headers: H })).json();
  const r = await (await fetch(`${BASE}/api/send`, { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: 'Hello?' }) })).json();
  const log = lib.readJsonl(path.join(TMP, 'logs', `${conv_id}.jsonl`));
  const c = await (await fetch(`${BASE}/api/conv/${conv_id}`, { headers: H })).json();
  return { r, log, c };
}

test('a connection that drops before any text is sent once more, and the reply is saved', async (t) => {
  const { r, log, c } = await dropServer(t, ['drop-before', 'ok']);
  assert.strictEqual(r.reply.text, 'Here you are.');
  const ev = log.find((e) => e.event === 'model call dropped, sent again');
  assert.ok(ev, 'the drop is logged');
  assert.strictEqual(ev.pieces_received, 0);
  assert.ok('cause' in ev && 'seconds_open' in ev);
  assert.strictEqual(c.failed, null);
});

test('a drop after the text began is not resent: the page says the model couldn\'t answer, until the next message', async (t) => {
  const { r, log, c } = await dropServer(t, ['drop-after', 'ok']);
  assert.ok(!r.reply, 'no reply');
  const ev = log.find((e) => e.event === 'model call failed');
  assert.ok(ev && ev.pieces_received > 0);
  assert.strictEqual(c.failed && c.failed.reason, 'the connection to the model server dropped');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /"The model couldn't answer: " \+ convFailed\.reason \+ '\. Send your message again\.'/);
});

#!/usr/bin/env node
// A tiny stand-in for a model server, so you can try local-harness with no model at all.
// It speaks the OpenAI-compatible API the harness uses: GET /v1/models and POST /v1/chat/completions (streamed or not).
//
//   node examples/fake-model.js                  listens on 127.0.0.1:8080 (FAKE_MODEL_PORT to change)
//
// What it does:
//   - echoes your message back, after a short made-up "thinking" (sent in the `reasoning` field, as mlx_lm.server does)
//   - if your message mentions "time" and the harness offers current_time, it calls that tool, then reports the result
//   - if your message contains "raw call", it writes a raw <tool_call> block into its text, as some models do
//   - if your message mentions is_prime (a coding question), it answers with a Python function, a different version each time, one in four
//     with a bug; asked for test inputs or a repair, it answers those too. Use it to try "Think harder" (needs trust.json think_harder + Docker).
//   - if your message contains "ask someone" and the harness offers ask_someone, it asks a question through that tool
//   - when the harness asks it to review its mistakes, it names a made-up kind of mistake and habit, so you can see the Review page work
//   - if your message contains "slow", it streams word by word with pauses, so you can watch the live view
// It knows nothing and checks nothing; it is only here to show how the harness behaves.

'use strict';

const http = require('node:http');

const PORT = Number(process.env.FAKE_MODEL_PORT || 8080);
const HOST = process.env.FAKE_MODEL_HOST || '127.0.0.1';

const lastOf = (messages, role) => [...messages].reverse().find((m) => m.role === role);
const textOf = (m) => (m && typeof m.content === 'string' ? m.content : '');

const GOOD = 'def is_prime(n):\n    if n < 2:\n        return False\n    i = 2\n    while i * i <= n:\n        if n % i == 0:\n            return False\n        i += 1\n    return True';
const BUGGY = 'def is_prime(n):\n    return n > 1 and all(n % i for i in range(2, n // 2))';
let codeCalls = 0;
const fence = (c) => `Here is a version.\n\`\`\`python\n${c}\n\`\`\``;

// What the fake model decides to do for one request.
function plan(body) {
  const messages = body.messages || [];
  const last = messages[messages.length - 1] || {};
  const user = textOf(lastOf(messages, 'user'));
  if (/write test inputs/i.test(textOf(last))) return { reasoning: 'I will list a few calls.', content: '```python\nis_prime(2)\nis_prime(9)\nis_prime(1)\nis_prime(97)\nis_prime(15)\n```' };
  if (/Your solution failed/.test(textOf(last))) return { reasoning: 'Fixing it.', content: fence(GOOD) };
  if (/\bis_prime\b/.test(user)) return { reasoning: 'A coding question. I will write the function.', content: fence(++codeCalls % 4 === 0 ? BUGGY : GOOD) };
  const whole = messages.map((m) => textOf(m)).join('\n');
  if (/write only "NONE"/.test(whole)) return { reasoning: 'Looking back.', content: 'NONE' };
  if (/Write exactly two lines/.test(whole)) return { reasoning: 'Naming it.', content: 'KIND: Careless sums\nHABIT: Recheck every sum with the calculator tool before stating it' };
  const offered = new Set((body.tools || []).map((t) => t.function && t.function.name));
  if (last.role === 'tool') {
    return { reasoning: 'A tool answered. I will pass its output on.', content: `The tool said: ${textOf(last).slice(0, 300)}` };
  }
  if (/raw call/i.test(user) && offered.has('current_time')) {
    return { reasoning: 'I will call the clock the raw way.',
      content: 'Checking the clock.\n<tool_call>\n<function=current_time>\n</function>\n</tool_call>' };
  }
  if (/ask someone/i.test(user) && offered.has('ask_someone')) {
    return { reasoning: 'I am unsure. I will ask.', tool: { name: 'ask_someone', arguments: JSON.stringify({ question: 'What is the boiling point of water at sea level, in degrees Celsius?' }) } };
  }
  if (/\btime\b/i.test(user) && offered.has('current_time')) {
    return { reasoning: 'The user asks about the time. I should use the clock tool.', tool: { name: 'current_time', arguments: '{}' } };
  }
  return { reasoning: `The user wrote ${user.length} characters. I will echo them.`, content: `You said: ${user.trim()}`, slow: /\bslow\b/i.test(user) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', created: 1, model: 'fake-model',
  choices: [{ index: 0, finish_reason: finish, delta }] }) + '\n\n';

async function stream(res, p) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
  res.write(': keepalive\n\n');
  const pieces = (s) => s.match(/\S+\s*/g) || [];
  for (const w of pieces(p.reasoning || '')) { res.write(chunk({ role: 'assistant', reasoning: w })); if (p.slow) await sleep(150); }
  for (const w of pieces(p.content || '')) { res.write(chunk({ content: w })); if (p.slow) await sleep(250); }
  if (p.tool) res.write(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: p.tool }] }));
  res.write(chunk({}, p.tool ? 'tool_calls' : 'stop'));
  res.write('data: ' + JSON.stringify({ id: 'fake-1', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}

function whole(res, p) {
  const message = { role: 'assistant', content: p.content || null, ...(p.reasoning ? { reasoning: p.reasoning } : {}) };
  if (p.tool) message.tool_calls = [{ id: 'call_1', type: 'function', function: p.tool }];
  res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
  res.end(JSON.stringify({ id: 'fake-1', object: 'chat.completion', created: 1, model: 'fake-model',
    choices: [{ index: 0, finish_reason: p.tool ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
  }
  if (req.method === 'POST' && req.url.split('?')[0] === '/v1/chat/completions') {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(s); } catch { res.writeHead(400); return res.end('bad json'); }
      const p = plan(body);
      return body.stream ? stream(res, p) : whole(res, p);
    });
    return undefined;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  return res.end('{"error":"not found"}');
});

server.listen(PORT, HOST, () => console.log(`fake model on http://${HOST}:${PORT} (answers /v1/models and /v1/chat/completions)`));

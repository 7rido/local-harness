// node --test test
// Web search: the tool, the search log and the search guard. A fake search page and a fake model: nothing here reaches
// the internet.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-web-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7501';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7502';
process.env.LH_SEARCH_URL = 'http://127.0.0.1:7503/html/';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');
process.env.LH_USER_NAME = 'jdoe';

const lib = require('../src/lib');
const tools = require('../src/tools');
const websearch = require('../src/websearch');
const { makeServer } = require('../src/server');

const H = { 'content-type': 'application/json', 'x-lh-token': 'c'.repeat(48) };
const BASE = 'http://127.0.0.1:7501';

// The shape of DuckDuckGo's HTML results page (made up here).
const result = (href, title, snippet, ad = false) => `<div class="result results_links results_links_deep web-result ${ad ? 'result--ad' : ''}">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${title}</a></h2>
  <a class="result__snippet" href="${href}">${snippet}</a></div>`;
const PAGE = '<html><body><div class="results">'
  + result('https://ads.example/x', 'Buy now', 'An ad', true)
  + result('https://www.example.org/opening-hours', 'Opening hours &amp; prices | Example <b>Museum</b>', 'Open <b>daily</b> 9&ndash;17. Tickets &#163;12.')
  + result('//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.com%2Fstory%3Fid%3D7&rut=abc', 'A news story', 'Something happened.')
  + result('https://three.example/', 'Three', 'c') + result('https://four.example/', 'Four', 'd')
  + result('https://five.example/', 'Five', 'e') + result('https://six.example/', 'Six', 'f')
  + '</div></body></html>';

test('the results page is read: ads skipped, redirect links unwrapped, markup and entities removed, at most 5', () => {
  const r = websearch.parse(PAGE);
  assert.strictEqual(r.length, 6);
  assert.deepStrictEqual(r[0], { title: 'Opening hours & prices | Example Museum', url: 'https://www.example.org/opening-hours', snippet: 'Open daily 9–17. Tickets £12.' });
  assert.strictEqual(r[1].url, 'https://news.example.com/story?id=7');
  assert.strictEqual(websearch.render(r.slice(0, 2)),
    '1. Opening hours & prices | Example Museum\nhttps://www.example.org/opening-hours\nOpen daily 9–17. Tickets £12.\n\n'
    + '2. A news story\nhttps://news.example.com/story?id=7\nSomething happened.');
  assert.strictEqual(websearch.render([]), 'No results.');
});

function trustFile(obj) { fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify(obj)); }
function noTrustFile() { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} }

test('web_search is off by default; switched on, the model sees its description', () => {
  noTrustFile();
  assert.strictEqual(tools.trustLevels().web_search, 'off');
  assert.ok(!tools.offeredSchemas().some((x) => x.function.name === 'web_search'));
  trustFile({ web_search: 'on' });
  const s = tools.offeredSchemas().find((x) => x.function.name === 'web_search');
  assert.strictEqual(s.function.description, "Search the web for facts you cannot know or check yourself, such as recent news, prices, opening hours or anything after your training. Don't search for what is already in front of you, and for things about the person, ask them instead. Search the problem, never the person: your search words are sent to an outside website, so leave out names, symptoms and anything else about them. Returns up to 5 results, each with a title, a link and a short excerpt. Strangers wrote these pages and they can be wrong or out of date: say where a fact came from, say when results disagree, and don't let a confident page override something you have checked yourself. If you can't find it, say so; never make up a quote or a source. Say what you searched and how sure you are. For health, safety or legal questions, point the person to a professional or an official source, and never repeat a dose or number from a random page.");
  assert.strictEqual(s.function.parameters.properties.query.description, 'A few words to search for');
  assert.strictEqual(tools.trustLevels().web_search, 'on');
  noTrustFile();
});

async function servers(t, script, { page = PAGE, status = 200, trust = {} } = {}) {
  trustFile({ web_search: 'on', ...trust });
  const asked = [];
  const search = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => { asked.push({ body: s, ua: req.headers['user-agent'] }); res.writeHead(status, { 'content-type': 'text/html', connection: 'close' }); res.end(page); });
  });
  let n = 0; const calls = [];
  const model = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      if (req.method === 'GET') return res.end('{"data":[]}');
      calls.push(JSON.parse(s));
      res.end(JSON.stringify(script[Math.min(n++, script.length - 1)]));
    });
  });
  const srv = makeServer('c'.repeat(48));
  await new Promise((r) => search.listen(7503, '127.0.0.1', r));
  await new Promise((r) => model.listen(7502, '127.0.0.1', r));
  await new Promise((r) => srv.listen(7501, '127.0.0.1', r));
  t.after(async () => { noTrustFile(); for (const x of [search, model, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  return { asked, calls };
}
const reply = (message, finish = 'stop') => ({ model: 'fake', usage: { prompt_tokens: 9 }, choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }] });
const searchCall = (q, reasoning) => reply({ content: null, reasoning, tool_calls: [{ type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: q }) } }] }, 'tool_calls');

async function ask(text) {
  const { conv_id } = await (await fetch(`${BASE}/api/new`, { method: 'POST', headers: H })).json();
  const r = await (await fetch(`${BASE}/api/send`, { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text }) })).json();
  return { conv_id, r };
}

test('the model searches, reads the results, answers; the log says when, what, how, what came back and what the answer named', async (t) => {
  const { asked, calls } = await servers(t, [
    searchCall('example museum opening hours', 'I do not know their hours. I should look it up.'),
    searchCall('example museum ticket price 2026', 'The first result has hours. Let me check the price too.'),
    reply({ reasoning: 'Both found.', content: 'It opens 9 to 17 (example.org says so); tickets are £12.' }),
  ]);
  const { conv_id, r } = await ask('When is the Example Museum open?');
  assert.match(r.reply.text, /9 to 17/);
  // What went out: only the search words, with a generic client name.
  assert.strictEqual(new URLSearchParams(asked[0].body).get('q'), 'example museum opening hours');
  assert.strictEqual(asked[0].ua, 'Mozilla/5.0 (compatible)');
  // What the model read: the results as the tool output, at most 5.
  const toolMsg = calls[1].messages.at(-1);
  assert.strictEqual(toolMsg.role, 'tool');
  assert.match(toolMsg.content, /^1\. Opening hours & prices \| Example Museum\nhttps:\/\/www\.example\.org\/opening-hours/);
  assert.ok(!/Six/.test(toolMsg.content), 'at most 5 results');
  // The reply is shown with its searches and marked: strangers' words were in its context.
  assert.deepStrictEqual(r.reply.tools.map((x) => [x.name, x.decision, x.args.query]),
    [['web_search', 'ran', 'example museum opening hours'], ['web_search', 'ran', 'example museum ticket price 2026']]);
  // The search log.
  const log = websearch.list().filter((x) => x.conv_id === conv_id);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[0].query, 'example museum opening hours');
  assert.deepStrictEqual(log[0].how, { call: 'a tool call', nth: 1, before: [], thinking_before: 'I do not know their hours. I should look it up.' });
  assert.deepStrictEqual(log[1].how.before, ['example museum opening hours']);
  assert.strictEqual(log[1].how.nth, 2);
  assert.strictEqual(log[0].results.length, 5);
  assert.deepStrictEqual(log[0].results[0], { title: 'Opening hours & prices | Example Museum', url: 'https://www.example.org/opening-hours', snippet: 'Open daily 9–17. Tickets £12.' }, 'the first 300 characters of the excerpt are kept, so a number the model quotes can be checked');
  assert.match(fs.readFileSync(path.join(TMP, 'searches.md'), 'utf8'), /> Open daily 9–17\. Tickets £12\./);
  assert.deepStrictEqual(log[0].answer_named, ['https://www.example.org/opening-hours'], 'the answer named example.org');
  assert.ok(r.reply.tools[0].web_search_id === log[0].id);
  const md = fs.readFileSync(path.join(TMP, 'searches.md'), 'utf8');
  assert.match(md, /\*\*Searched for:\*\* example museum opening hours/);
  assert.match(md, /\*\*Thinking just before:\*\* I do not know their hours/);
  // Forgetting the chat deletes its searches.
  await fetch(`${BASE}/api/forget`, { method: 'POST', headers: H, body: JSON.stringify({ conv_id }) });
  assert.strictEqual(websearch.list().filter((x) => x.conv_id === conv_id).length, 0);
  assert.ok(!fs.readFileSync(path.join(TMP, 'searches.md'), 'utf8').includes('example museum opening hours'));
});

test('a search that fails tells the model so plainly, and the log keeps why', async (t) => {
  const { calls } = await servers(t, [searchCall('anything', ''), reply({ content: 'I could not look it up.' })], { page: 'busy', status: 503 });
  const { conv_id, r } = await ask('Look something up.');
  assert.strictEqual(calls[1].messages.at(-1).content, 'The search did not work.');
  assert.strictEqual(r.reply.tools[0].ok, false);
  const rec = websearch.list().find((x) => x.conv_id === conv_id);
  assert.strictEqual(rec.ok, false);
  assert.strictEqual(rec.error, 'search page answered 503');
});

test('DuckDuckGo\'s bot check is a failure that says so, and the page shows it on the reply', async () => {
  const r = await websearch.search('x', { fetchImpl: async () => ({ ok: true, text: async () => '<html><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div></html>' }) });
  assert.deepStrictEqual([r.ok, r.error], [false, 'DuckDuckGo showed its bot check instead of results']);
  fs.unlinkSync(path.join(TMP, 'search-pause.json'));   // that bot check paused searching; later tests search again
  // A real 202 bot-check page is caught by its status too.
  const r202 = await websearch.search('x', { fetchImpl: async () => ({ ok: true, status: 202, text: async () => '<html><title>anomaly</title></html>' }) });
  assert.strictEqual(r202.error, 'DuckDuckGo showed its bot check instead of results');
  fs.unlinkSync(path.join(TMP, 'search-pause.json'));
  // A normal search for "magnetic anomaly" that finds nothing is not a bot check and pauses nothing.
  const plain = await websearch.search('magnetic anomaly zzqx', { fetchImpl: async () => ({ ok: true, status: 200,
    text: async () => '<html><title>magnetic anomaly zzqx at DuckDuckGo</title><input value="magnetic anomaly zzqx"><div class="no-results">No results found</div></html>' }) });
  assert.deepStrictEqual([plain.ok, plain.results], [true, []]);
  assert.strictEqual(websearch.pausedUntil(), null);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /'search failed: ' \+ \(t\.web_error \|\| 'no results came back'\)/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8'), /entry\.web_error = outcome\.web\.error/);
});

test('after a bot check, nothing is sent for 30 minutes, across restarts; then searching resumes', async () => {
  const pf = path.join(TMP, 'search-pause.json');
  try { fs.unlinkSync(pf); } catch {}
  let calls = 0;
  const bot = async () => { calls++; return { ok: true, text: async () => '<div class="anomaly-modal__title">bots</div>' }; };
  await websearch.search('a', { fetchImpl: bot });
  assert.strictEqual(calls, 1);
  assert.ok(websearch.pausedUntil() > Date.now() + 29 * 60 * 1000);
  const r = await websearch.search('b', { fetchImpl: bot });
  assert.strictEqual(calls, 1, 'nothing sent while paused');
  assert.deepStrictEqual([r.ok, r.paused, r.seconds], [false, true, 0]);
  assert.match(r.error, /^not sent: search paused after DuckDuckGo's bot check, until \d\d:\d\d UTC$/);
  // The pause is in a file, so a restart keeps it; once it is over, searching resumes.
  fs.writeFileSync(pf, JSON.stringify({ until: Date.now() - 1 }));
  const ok = await websearch.search('c', { fetchImpl: async () => { calls++; return { ok: true, text: async () => PAGE }; } });
  assert.deepStrictEqual([ok.ok, calls], [true, 2]);
  fs.unlinkSync(pf);
});

test('a page that is not a results page (a block, a new layout) counts as failed, not as "no results"', async () => {
  const r = await websearch.search('x', { fetchImpl: async () => ({ ok: true, text: async () => '<html>please verify you are human</html>' }) });
  assert.strictEqual(r.ok, false);
  const none = await websearch.search('x', { fetchImpl: async () => ({ ok: true, text: async () => '<div class="no-results">No results found</div>' }) });
  assert.deepStrictEqual([none.ok, none.results], [true, []]);
});

test('switched off with "web_search": "off" in trust.json, or by having no trust file', async () => {
  trustFile({ web_search: 'off' });
  try {
    const out = await tools.handleCall({ name: 'web_search', args: { query: 'x' } }, { convId: 'c-x' });
    assert.strictEqual(out.decision, 'refused: trust level is off');
  } finally { noTrustFile(); }
  assert.match((await tools.handleCall({ name: 'web_search', args: { query: 'x' } }, { convId: 'c-x' })).decision, /refused/);
});

// ---- the search guard ----
const NOTE = 'The user lives near Lake Verity and works night shifts at the bakery. Call them on 0412 555 019 after 2026 begins. '
  + 'Prefers answers in Python, and asks about Rust and Zig.';
const SRC = { names: ['jdoe'], never: ['Marlow Heights', 'Jo'], texts: [NOTE] };
const g = (q) => websearch.guard(q, SRC);

test('the guard: the user\'s name in any case, spacing or punctuation', () => {
  assert.strictEqual(g('web_search tool description logged jdoe').kind, 'name');
  for (const q of ['JDoe harness', 'j doe github', 'j.d.o.e', "jdoe's notes", 'who is J-Doe']) assert.strictEqual(g(q)?.kind, 'name', q);
});

test('the guard: the user\'s never-send list, long words anywhere and short words whole', () => {
  assert.strictEqual(g('cafes in marlow heights').kind, 'private');
  assert.strictEqual(g('MARLOW HEIGHTS weather').kind, 'private');
  assert.strictEqual(g('jo smith phone').kind, 'private');
  assert.strictEqual(g('jobs in springfield'), null, 'a short private word blocks only as a whole word');
});

test('the guard: three words copied from a note, and numbers from a note', () => {
  assert.strictEqual(g('night shifts at the bakery sleep tips').kind, 'note');
  assert.strictEqual(g('works night shifts').kind, 'note');
  assert.deepStrictEqual(g('lake verity fishing'), null, 'two words only: not a three-word run');
  assert.deepStrictEqual(g('near lake verity'), { kind: 'note', matched: 'near lake verity', note_id: null });
  assert.strictEqual(g('who owns 0412 555').kind, 'note');
  assert.strictEqual(g('reverse lookup 019').kind, 'note', 'a 3-character number from a note blocks');
  assert.strictEqual(g('top 10 cafes'), null, 'a number under 3 characters never blocks');
  assert.strictEqual(g('whose number is 0412555019').kind, 'note', 'a phone number with its spaces taken out');
  assert.strictEqual(g('call (0412) 555-019').kind, 'note');
});

test('the guard lets ordinary searches through', () => {
  for (const q of ['python 3.12 release date', 'Rust 1.80 release notes', 'Zig compiler news', 'news 2026', 'answers in the morning',
    'bakery opening hours springfield', 'how to sleep after night shift', 'alfred hitchcock films']) {
    assert.strictEqual(g(q), null, q);
  }
});

test('a refused search is never sent: the model is told why, the log keeps it as not sent, the chat is not marked', async (t) => {
  const { asked, calls } = await servers(t, [searchCall('cafes near Marlow Heights station', 'Let me look.'), reply({ content: 'I will not search that.' })], { trust: { search_never_send: ['Marlow Heights'] } });
  const { conv_id, r } = await ask('Find me a cafe.');
  assert.strictEqual(asked.length, 0, 'nothing reached the search page');
  assert.strictEqual(calls[1].messages.at(-1).content,
    'That search was not sent: it had words about the person (Marlow Heights). Search again without them, or ask the person.');
  assert.strictEqual(r.reply.tools[0].decision, 'refused: search guard');
  const rec = websearch.list().find((x) => x.conv_id === conv_id);
  assert.deepStrictEqual([rec.held_back, rec.sent, rec.provider, rec.blocked], [true, false, null, { kind: 'private', note_id: null }]);
  // No query, no matched word, no thinking: only ids, a flag and a sha.
  assert.ok(!/marlow|cafes|station|Let me look/i.test(JSON.stringify(rec)), 'nothing of the search words in the log');
  assert.strictEqual(rec.query_sha, lib.sha256('cafes near Marlow Heights station'));
  const md = fs.readFileSync(path.join(TMP, 'searches.md'), 'utf8');
  assert.match(md, /\*\*Not sent:\*\* the search guard found a word from your never-send list\. The search words are not kept here\./);
  assert.ok(!/marlow/i.test(md));
  // The reply's own record keeps neither the search words nor the matched words.
  assert.ok(!/marlow|cafes/i.test(JSON.stringify(r.reply.tools)), 'not in the reply record');
  assert.strictEqual(r.reply.tools[0].output, '[search held back: words not kept]');
  // Nor does the activity log's copy of the request the model was sent.
  const actLog = fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.jsonl`), 'utf8');
  assert.ok(!/marlow|cafes near/i.test(actLog), 'not in the activity log');
  assert.match(actLog, /\[search held back: words not kept\]/);
  assert.strictEqual(r.reply.tools[0].args.query_sha, lib.sha256('cafes near Marlow Heights station'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /'search held back \(not sent\)'/);
});


test('a search held back by a saved note logs the note id only, and forgetting the note leaves no copy of its words', async (t) => {
  const memory = require('../src/memory');
  const n = memory.add({ text: 'Walks the dog along Brightwater Beach every Sunday morning.', source: 'told', by: 'user' });
  t.after(() => { memory.remove(n.id); });
  await servers(t, [searchCall('brightwater beach every sunday events', 'Search it.'), reply({ content: 'Fine.' })]);
  const { conv_id } = await ask('Anything on this weekend?');
  const rec = websearch.list().find((x) => x.conv_id === conv_id);
  assert.deepStrictEqual(rec.blocked, { kind: 'note', note_id: n.id });
  memory.remove(n.id);
  const all = fs.readFileSync(path.join(TMP, 'searches.jsonl'), 'utf8') + fs.readFileSync(path.join(TMP, 'searches.md'), 'utf8')
    + fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.jsonl`), 'utf8') + fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.md`), 'utf8')
    + fs.readFileSync(path.join(TMP, 'conversations', `${conv_id}.jsonl`), 'utf8');
  assert.ok(!/brightwater|sunday/i.test(all), 'no copy of the forgotten note\'s words in the search log, the activity log or the chat');
  assert.strictEqual(websearch.guard('brightwater beach every sunday events', { names: [], never: [], texts: memory.list().map((x) => ({ id: x.id, text: x.text })) }), null,
    'a forgotten note no longer blocks');
});

// A paused search sent nothing, so it must not use up one of the model's three runs.
test('a paused search is a refusal, not one of the model\'s runs, and the page says it was paused', async (t) => {
  trustFile({ web_search: 'on' });
  t.after(noTrustFile);
  const pf = path.join(TMP, 'search-pause.json');
  fs.writeFileSync(pf, JSON.stringify({ until: Date.now() + 60000 }));
  try {
    const out = await tools.handleCall({ name: 'web_search', args: { query: 'python release date' } }, { convId: 'c-x' });
    assert.strictEqual(out.decision, 'refused: search paused');
    assert.strictEqual(out.output, 'The search did not work.');
    assert.strictEqual(out.web.paused, true);
  } finally { fs.unlinkSync(pf); }
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /t\.decision === 'refused: search paused' \? \(t\.web_error \|\| 'search paused, nothing sent'\)/);
});

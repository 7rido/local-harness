// node --test test
// The reply checks: phone numbers, invented sources, arithmetic and text posing as tool output. A number or a source the
// model names is marked found (and where) or not in anything it looked up. All fixtures are invented: a made-up harbour
// town ("Bayport"), a made-up directory ("Directory Plus") and fake numbers.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-numbers-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7521';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7522';
process.env.LH_SEARCH_URL = 'http://127.0.0.1:7523/html/';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');
process.env.LH_EMERGENCY_CARD = path.join(TMP, 'emergency_card.txt');

const lib = require('../src/lib');
const { makeServer } = require('../src/server');
const numbers = (t) => lib.checkFlags(t).flags.filter((f) => f.type === 'number').map((f) => f.match);

test('short service numbers next to a contact word are flagged; arithmetic and years are not', () => {
  assert.deepStrictEqual(numbers('call 654'), ['654']);
  for (const n of ['654', '159', '987', '246']) assert.deepStrictEqual(numbers(`For that, dial ${n}.`), [n]);
  assert.deepStrictEqual(numbers('3 × 321 = 963'), []);
  assert.deepStrictEqual(numbers('the number of cases rose in 1998'), []);
  assert.deepStrictEqual(numbers('The clock says 2026-11-25 and UTC 2026-11-25T04:50:09Z.'), [], 'an ISO date is not a phone number');
  assert.deepStrictEqual(numbers('The harbour coast guard: 1420'), ['1420']);
  assert.deepStrictEqual(numbers('Harbour Police Bayport 020 7946 0188'), ['020 7946 0188'], 'a service word is a contact word');
  // A bare freephone prefix given as if it were the whole number is still flagged.
  assert.deepStrictEqual(numbers('Call the Rescue Information Service at **0800** (free, 24/7) or **999**.'), ['0800', '999']);
  assert.deepStrictEqual(numbers('call 0800 123 4567'), ['0800 123 4567'], 'a whole number is still one number');
});

test('a number counts as found when its digits are in what the model saw, a country code allowed', () => {
  const src = [{ name: 'web_search', text: '1. Emergency numbers in Bayport\nhttps://x.example\nCall 777 for any emergency. Harbour Rescue desk: +44 20 7946 0155.' }];
  assert.deepStrictEqual(lib.sourceNumbers(['777', '020 7946 0155', '020 7946 0188', '888'], src),
    { found: [{ number: '777', source: 'web_search' }, { number: '020 7946 0155', source: 'web_search' }], unsourced: ['020 7946 0188', '888'] });
});

test('through the harness: 777 and 020 7946 0155 found in the search, 020 7946 0188 not; the reference card counts', async (t) => {
  fs.writeFileSync(process.env.LH_EMERGENCY_CARD, 'Reference line (checked by me): 020 7946 0321\n');
  fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ web_search: 'on' }));
  const search = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/html', connection: 'close' });
      res.end('<div class="result results_links web-result "><a rel="nofollow" class="result__a" href="https://bayport.example/numbers">888 Harbour Police | Emergency numbers in Bayport</a>'
        + '<a class="result__snippet" href="https://bayport.example/numbers">Call 777 for any emergency. Harbour Rescue desk 020 7946 0155.</a></div>');
    });
  });
  let n = 0;
  const script = [
    { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'web_search', arguments: '{"query":"police number Bayport"}' } }] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Call 777 for any emergency, or the Rescue desk on 020 7946 0155. Harbour Police Bayport 020 7946 0188 (Directory Plus confirms 020 7946 0188). Reference line: 020 7946 0321.' } }] },
  ];
  const model = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      if (req.method === 'GET') return res.end('{"data":[]}');
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 9 }, ...script[Math.min(n++, script.length - 1)] }));
    });
  });
  const srv = makeServer('e'.repeat(48));
  for (const [x, p] of [[search, 7523], [model, 7522], [srv, 7521]]) await new Promise((r) => x.listen(p, '127.0.0.1', r));
  t.after(async () => { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} for (const x of [search, model, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': 'e'.repeat(48) };
  const { conv_id } = await (await fetch('http://127.0.0.1:7521/api/new', { method: 'POST', headers: H })).json();
  const r = await (await fetch('http://127.0.0.1:7521/api/send', { method: 'POST', headers: H,
    body: JSON.stringify({ conv_id, text: 'What number do I call for the police in Bayport?' }) })).json();
  assert.strictEqual(r.reply.text, script[1].choices[0].message.content, 'the reply is never changed');
  assert.deepStrictEqual(r.reply.numbers_unsourced, ['020 7946 0188']);
  assert.deepStrictEqual(r.reply.numbers_found, [
    { number: '020 7946 0155', source: 'web_search' }, { number: '020 7946 0321', source: 'your emergency card' }, { number: '777', source: 'web_search' }]);
  // The invented source: "Directory Plus" is in no result.
  assert.deepStrictEqual(r.reply.sources_unsourced, ['Directory Plus']);
  const ev = lib.readJsonl(path.join(TMP, 'logs', `${conv_id}.jsonl`)).find((e) => e.type === 'reply');
  assert.deepStrictEqual(ev.numbers_unsourced, ['020 7946 0188']);
});

test('the page: a strong warning for a number the model did not look up, and where found numbers came from', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /in anything it looked up\. Don't rely on /);
  assert.match(html, /'Numbers found in what the model looked up: '/);
  assert.match(html, /\.numwarn \{ border-width:2px;/);
});

test('the sources the model names are found', () => {
  assert.deepStrictEqual(lib.sourceClaims('Directory Plus confirms 020 7946 0188.'), ['Directory Plus']);
  assert.deepStrictEqual(lib.sourceClaims('According to the Harbour Police Authority, dial 654.'), ['Harbour Police Authority']);
  assert.deepStrictEqual(lib.sourceClaims('The Ministry of the Interior lists 777.'), ['Ministry of the Interior']);
  assert.deepStrictEqual(lib.sourceClaims('As listed on directoryplus.org, call 020 7946 0142.'), ['directoryplus.org']);
  assert.deepStrictEqual(lib.sourceClaims('I got these from official sources.'), ['official sources']);
  for (const t of ['It says 321 is the number.', 'You said 321.', 'I think it is 4.']) assert.deepStrictEqual(lib.sourceClaims(t), [], t);
  assert.deepStrictEqual(lib.sourceClaims('Research shows that sleep matters.'), ['research shows'], 'a vague claim');
});

test('a named source is found in what the model saw, also with spaces or a domain; "official sources" only after a web search', () => {
  const web = [{ name: 'web_search', text: '1. Useful numbers | DirectoryPlus\nhttps://www.directoryplus.org/numbers\nHarbour Police Authority: 654.' }];
  assert.deepStrictEqual(lib.checkSources(['Directory Plus', 'Harbour Police Authority', 'Wikipedia', 'official sources'], web),
    { found: [{ name: 'Directory Plus', source: 'web_search' }, { name: 'Harbour Police Authority', source: 'web_search' }, { name: 'official sources', source: 'web_search' }],
      unsourced: ['Wikipedia'] });
  assert.deepStrictEqual(lib.checkSources(['official sources'], [{ name: 'your messages', text: 'official sources' }]).unsourced, ['official sources'],
    'without a web search, "official sources" is not backed');
});

test('the page: a strong warning for a source the model named but never looked up', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /' may be made up\.'/);
  assert.match(html, /'Sources the model named that are in what it looked up: '/);
});

test('a list of numbers in a source backs each of them; a split-up number still matches', () => {
  const src = [{ name: 'web_search', text: 'Numbers: 321 654 987 159\nRescue desk +44 20 7946 0155' }];
  assert.deepStrictEqual(lib.sourceNumbers(['321', '654', '987', '159', '020 7946 0155'], src).unsourced, []);
  assert.deepStrictEqual(lib.sourceNumbers(['112113'], [{ name: 'w', text: '321\n113' }]).unsourced, ['112113'], 'not joined across lines');
});

test('a named source must match as a whole word', () => {
  assert.deepStrictEqual(lib.checkSources(['Mum'], [{ name: 'w', text: 'the minimum wage' }]).unsourced, ['Mum']);
  assert.deepStrictEqual(lib.checkSources(['Mum'], [{ name: 'w', text: 'Mum said so' }]).unsourced, []);
  assert.deepStrictEqual(lib.checkSources(['Directory Plus'], [{ name: 'w', text: 'https://www.directoryplus.org' }]).unsourced, [], 'one-word or domain form');
});

test('past-chat search: only the user\'s side counts, so a number the model made up before does not back itself', () => {
  const tools = require('../src/tools');
  const recall = require('../src/recall');
  const orig = recall.search;
  recall.search = () => [{ conv_id: 'c-old', ts: new Date().toISOString(), user: 'My doctor is on 0412 000 111.', reply: 'Harbour Police 020 7946 0188.' }];
  return tools.TOOLS.search_chats.run({ query: 'x' }, { convId: 'c-now' }).then((res) => {
    recall.search = orig;
    assert.strictEqual(res.user_text, 'My doctor is on 0412 000 111.');
    const check = lib.sourceNumbers(['020 7946 0188', '0412 000 111'], [{ name: 'you said it in a past chat', text: res.user_text }]);
    assert.deepStrictEqual(check.unsourced, ['020 7946 0188']);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    assert.match(src, /recalledUser\.map\(\(text\) => \(\{ name: 'you said it in a past chat', text \}\)\)/);
    assert.ok(!/hidden\.map\(\(text\) => \(\{ name: 'search_chats'/.test(src), 'the model\'s recalled replies are not a source');
  });
});

test('short numbers count only when they look like a phone number; units and plain mentions do not', () => {
  for (const t of ['error number 404', 'line 120', 'The API call takes 200 ms over 100 calls.', 'The hospital has 300 beds.', 'rose by 250', 'pi is 3.1415926']) {
    assert.deepStrictEqual(numbers(t), [], t);
  }
  assert.deepStrictEqual(numbers('In an emergency in the UK, ring 999.'), ['999']);
  assert.deepStrictEqual(numbers('Harbour Police Bayport 020.7946.0188'), ['020.7946.0188'], 'a number with dots');
  assert.deepStrictEqual(numbers('If the child is conscious and stable, call 0800 (or 0845 from a mobile).'), ['0800', '0845']);
  assert.deepStrictEqual(numbers('Call 321, 654 or 159.'), ['321', '654', '159'], 'a list after a flagged number');
  assert.deepStrictEqual(numbers('The mobile app takes 300 ms.'), [], 'a unit still wins');
  assert.deepStrictEqual(numbers('Results: 404 then 500.'), []);
  assert.deepStrictEqual(numbers('Call 321 or 159 in Bayport'), ['321', '159']);
  assert.deepStrictEqual(numbers('Ambulance: 159. Fire: 987.'), ['159', '987']);
  assert.deepStrictEqual(numbers('The server can fire 100 requests.'), [], 'a unit still wins');
  assert.deepStrictEqual(numbers('The mobile app returned 404.'), [], '"mobile" alone is not phone context');
  assert.deepStrictEqual(numbers('Call 321 or 159; line 120'), ['321', '159'], 'a semicolon breaks the chain');
  assert.deepStrictEqual(lib.sourceClaims('You pay per User per Month.'), []);
});

test('vague claims and bare web addresses are sources; units after "per" are not', () => {
  assert.deepStrictEqual(lib.sourceClaims('Studies show that sleep matters.'), ['studies show']);
  assert.deepStrictEqual(lib.sourceClaims('The docs say to use it.'), ['docs say']);
  assert.deepStrictEqual(lib.sourceClaims('Visit www.harbourpolice.org for more.'), ['harbourpolice.org']);
  assert.deepStrictEqual(lib.sourceClaims('per Month you pay 5.'), []);
  const web = [{ name: 'web_search', text: '1. A study\nhttps://example.org\nexcerpt' }];
  assert.deepStrictEqual(lib.checkSources(['studies show', 'docs say'], web).unsourced, [], 'backed by a real web search');
  assert.deepStrictEqual(lib.checkSources(['studies show'], [{ name: 'you gave it', text: 'studies show' }]).unsourced, ['studies show']);
  assert.deepStrictEqual(lib.checkSources(['harbourpolice.org'], [{ name: 'web_search', text: 'https://www.harbourpolice.org/x' }]).unsourced, []);
});

// Every search had failed and no page was read, yet the model wrote "From the page: …".
test('"from the page" and "the tool found" are claims, backed only by a search with results or a page the model read', () => {
  const t = 'From the page: The Grand Canyon is 277 miles long. The tool filled in the details. My search found the rest.';
  const claims = lib.sourceClaims(t);
  assert.deepStrictEqual(claims, ['from the page', 'tool filled in', 'my search found']);
  assert.deepStrictEqual(lib.checkSources(claims, [{ name: 'web_search', text: 'The search did not work.' }]).unsourced, claims);
  assert.deepStrictEqual(lib.checkSources(claims, [{ name: 'web_fetch (https://x.example/)', text: 'a page' }]).unsourced, []);
  assert.deepStrictEqual(lib.sourceClaims('The results were good and the page loads fast.'), []);
});

// "the tool returned 42" after a real run is true; "based on my search" is a claim too.
test('a claim about the tool is backed by any tool that ran; "based on my search" counts as a claim', () => {
  const claims = lib.sourceClaims('I ran it: the tool returned 42. Based on my search, it is 4.');
  assert.deepStrictEqual(claims, ['tool returned', 'based on my search']);
  const ran = [{ name: 'run_python', text: '42', ok: true }];
  assert.deepStrictEqual(lib.checkSources(claims, ran).unsourced, ['based on my search'], 'a Python run backs the tool claim, not the search claim');
  assert.deepStrictEqual(lib.checkSources(['tool returned'], [{ name: 'run_python', text: 'Traceback…', ok: false }]).unsourced, ['tool returned'], 'a failed run does not');
  assert.deepStrictEqual(lib.checkSources(['tool filled in'], [{ name: 'web_search', text: 'The search did not work.', ok: false }]).unsourced, ['tool filled in']);
});

// "19,340 ÷ 3.28084 = 5,894.93" has nothing in check_flags, and the real value is 5,894.83. The plain arithmetic rule
// catches it; it is shown on the reply and recorded in any chat.
test('arithmetic that does not work out is recorded on the reply and shown on the page', async (t) => {
  const model = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      if (req.method === 'GET') return res.end('{"data":[]}');
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 5 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: 'So 19,340 ÷ 3.28084 = 5,894.93 and 19,341 ÷ 3.28084 = 5,895.76, and 17 × 24 = 408.' } }] })); });
  });
  const srv = makeServer('k'.repeat(48));
  await new Promise((r) => model.listen(7522, '127.0.0.1', r));
  await new Promise((r) => srv.listen(7521, '127.0.0.1', r));
  t.after(async () => { for (const x of [model, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': 'k'.repeat(48) };
  const { conv_id } = await (await fetch('http://127.0.0.1:7521/api/new', { method: 'POST', headers: H })).json();
  const r = await (await fetch('http://127.0.0.1:7521/api/send', { method: 'POST', headers: H, body: JSON.stringify({ conv_id, text: 'Convert 19,340 ft.' }) })).json();
  assert.deepStrictEqual(r.reply.arithmetic_slips.map((s) => [s.expr, s.claimed, s.actual]),
    [['19,340 ÷ 3.28084', '5,894.93', '5894.831811'], ['19,341 ÷ 3.28084', '5,895.76', '5895.136611']]);
  assert.strictEqual(r.reply.text, 'So 19,340 ÷ 3.28084 = 5,894.93 and 19,341 ÷ 3.28084 = 5,895.76, and 17 × 24 = 408.', 'the reply is never changed');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  assert.match(html, /': that is not right\. It works out to ' \+ a\.actual \+ '\. Check any figure that came from this\.'/);
});

test('arithmetic: times, ratios, decimal commas and quoted sums are not judged; a wrong sum of the model\'s own still is', () => {
  const a = (t, seen) => lib.arithmeticSlips(t, seen).filter((x) => !x.quoted).map((x) => x.expr);
  for (const t of ['At 10:30 + 2 = 12:30', 'The ratio 16:9 / 2 = 8', '3,5 + 1 = 4,5', '€19,99 × 2 = €39,98']) assert.deepStrictEqual(a(t), [], t);
  // A sum that is also in what the model was shown is still judged (it is wrong whoever wrote it), but marked quoted.
  const q = (t, seen) => lib.arithmeticSlips(t, seen).map((x) => [x.expr, Boolean(x.quoted)]);
  assert.deepStrictEqual(q('Someone said 2+2=5, so 17 × 24 = 418.', ['you wrote 2+2=5 earlier']), [['2 + 2', true], ['17 × 24', false]]);
  assert.deepStrictEqual(q('Yes, 17 × 24 = 418.', ['Is 17 × 24 = 418?']), [['17 × 24', true]], 'endorsing the user\'s wrong sum: flagged, not hidden');
  assert.deepStrictEqual(q('The page says 19,340 ÷ 3.28084 = 5,894.93.', ['the page: 19,340 ÷ 3.28084 = 5,894.93']), [['19,340 ÷ 3.28084', true]], 'relaying a false figure');
  assert.deepStrictEqual(a('Someone said 2+2=5, so 17 × 24 = 418.', ['you wrote 2+2=5 earlier']), ['17 × 24'], 'its own slip is the one not marked quoted');
  assert.deepStrictEqual(a('So 17 × 24 = 418.'), ['17 × 24'], 'its own wrong sum is still caught');
  assert.strictEqual(lib.arithmeticSlips('So 17 × 24 = 418, then more')[0].claimed, '418');
  assert.strictEqual(lib.arithmeticSlips('17 × 24 = 418,')[0].claimed, '418', 'no trailing comma');
});

test('text posing as a tool run, in a reply where no such tool ran, is an invented source', () => {
  const said = "reading your earlier chat logs now. Here's what you wrote before... running web_search for the rescue desk number... web_search results: - '555-0142'";
  const claims = lib.sourceClaims(said);
  assert.deepStrictEqual(claims.sort(), ['a search_chats run', 'a web_search run']);
  assert.deepStrictEqual(lib.checkSources(claims, [{ name: 'you gave it', text: 'rescue desk' }]).unsourced.sort(), ['a search_chats run', 'a web_search run']);
  const ran = lib.checkSources(claims, [{ name: 'web_search', text: 'https://x.org 555-0142', ok: true }, { name: 'search_chats', text: 'old chat', ok: true }]);
  assert.deepStrictEqual(ran.unsourced, [], 'both tools really ran');
  for (const t of ['I cannot run web_search here.', 'The results were fine.', 'I read your messages.']) assert.deepStrictEqual(lib.sourceClaims(t), [], t);
});

test('a stray think tag in the answer is dropped and the words stay', () => {
  const r = lib.splitReply({ message: { reasoning: 'r', content: 'before </think> after' }, finish_reason: 'stop' });
  assert.strictEqual(r.text, 'before  after');
  assert.ok(!/think>/.test(r.text));
});

test('honest mentions of a tool are not claims that it ran', () => {
  for (const t of [
    "I haven't used web_search here, so this is from memory.", "I'm not using web_search for this one.", 'Without calling web_search I can only guess.',
    'If you want, I can try using web_search to check.', "I'm not reading your earlier chat logs now; I only see this chat.",
    'web_search returned nothing because tools are off.', 'The web_search results I showed you earlier were wrong.', "I can't run web_search.",
    'web_search returned an error.', 'web_search found nothing useful.',
  ]) assert.deepStrictEqual(lib.sourceClaims(t), [], t);
});

test('more ways of posing as a tool run are caught', () => {
  const run = (t) => lib.sourceClaims(t);
  assert.deepStrictEqual(run('Web search results:\n- one'), ['a web_search run']);
  assert.deepStrictEqual(run('Results from web_search: one'), ['a web_search run']);
  assert.deepStrictEqual(run('web_search found three pages about it.'), ['a web_search run']);
  assert.deepStrictEqual(run('Executing run_python... output: 42'), ['a run_python run']);
  assert.deepStrictEqual(run('Python output: 42'), ['a run_python run']);
  assert.deepStrictEqual(run('web-search results: one'), ['a web_search run']);
  assert.deepStrictEqual(run('Here: <tool_response>{"n":42}</tool_response>'), ['a tool_response block']);
});

test('any attempt of the tool backs the claim, failed or not; a tool_response block needs some tool run', () => {
  assert.deepStrictEqual(lib.checkSources(['a web_search run'], [{ name: 'web_search', text: 'failed', ok: false }]).unsourced, []);
  assert.deepStrictEqual(lib.checkSources(['a web_search run'], [{ name: 'run_python', text: '4', ok: true }]).unsourced, ['a web_search run']);
  assert.deepStrictEqual(lib.checkSources(['a tool_response block'], [{ name: 'you gave it', text: 'x' }]).unsourced, ['a tool_response block']);
  assert.deepStrictEqual(lib.checkSources(['a tool_response block'], [{ name: 'run_python', text: '4' }]).unsourced, []);
});

test('a stray think tag inside backticks stays, and the others are counted', () => {
  const r = lib.splitReply({ message: { reasoning: 'r', content: 'Use `<think>` first. a</think> b' }, finish_reason: 'stop' });
  assert.strictEqual(r.text, 'Use `<think>` first. a b');
  assert.strictEqual(r.strayThinkTags, 1);
  assert.strictEqual(lib.splitReply({ message: { reasoning: 'r', content: 'plain' }, finish_reason: 'stop' }).strayThinkTags, undefined);
});

test('the bare word "python" is a claim only as a "Python output:" heading at the start of a line', () => {
  for (const x of ["Here's a short script using Python:\n```py\nprint(1)\n```", 'I used Python syntax below', 'Expected Python output:\n42',
    'Python found its way into science', 'Yesterday you ran Python on your laptop']) assert.deepStrictEqual(lib.sourceClaims(x), [], x);
  assert.deepStrictEqual(lib.sourceClaims('Python output: 42'), ['a run_python run']);
  assert.deepStrictEqual(lib.sourceClaims('Sure.\nPython output:\n42'), ['a run_python run']);
  assert.deepStrictEqual(lib.sourceClaims('running run_python now'), ['a run_python run']);
});

test('the guard looks at the few words before: a weak word counts only right before the verb', () => {
  for (const x of ['Let me see what I can find — running web_search now: 1. one', 'As you can see, web_search results: one', 'No worries, running web_search for it'])
    assert.deepStrictEqual(lib.sourceClaims(x), ['a web_search run'], x);
  for (const x of ['I can try using web_search.', 'If you like, I can use web_search.', "I can't make a <tool_response> myself."]) assert.deepStrictEqual(lib.sourceClaims(x), [], x);
});

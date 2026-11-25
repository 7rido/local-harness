// node --test test
// Memory: notes the user approves. A fake model server; invented notes only, in a temporary data folder.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-mem-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7451';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7452';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');

const memory = require('../src/memory');
const tools = require('../src/tools');
const { makeServer } = require('../src/server');

const NOTE = 'Prefers recipes without onion';
const HEADER = memory.WORDING.header;

function setOn(extra = {}) { fs.writeFileSync(process.env.LH_TRUST_FILE, JSON.stringify({ memory: 'on', ...extra })); }
function setOff() { try { fs.unlinkSync(process.env.LH_TRUST_FILE); } catch {} }
function clearNotes() { for (const n of memory.list()) memory.remove(n.id); }

// Every file under the data dir that contains `text`.
function filesWith(text, dir = TMP) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesWith(text, p));
    else if (e.name !== 'trust.json' && fs.readFileSync(p, 'utf8').includes(text)) out.push(path.relative(TMP, p));
  }
  return out;
}

test('memory is off by default: no notes in the context, no remember tool', async () => {
  setOff(); clearNotes();
  memory.add({ text: 'Likes plain answers', source: 'wrote' });
  assert.strictEqual(memory.status().on, false);
  assert.match(memory.status().why_off, /trust\.json/);
  assert.strictEqual(memory.block(), null);
  assert.ok(!tools.offeredSchemas().some((s) => s.function.name === 'remember'));
  const r = await tools.handleCall({ name: 'remember', args: { text: 'x', source: 'told' } }, { convId: 'c-x' });
  assert.match(r.decision, /^refused/);
  setOn();
  assert.strictEqual(memory.status().on, true);
  assert.ok(tools.offeredSchemas().some((s) => s.function.name === 'remember'));
  setOff(); clearNotes();
});

test('the store: sources are checked, text is capped, edits keep no history, delete really deletes', () => {
  clearNotes();
  assert.throws(() => memory.add({ text: 'x', source: 'checked' }), /source/);
  assert.throws(() => memory.add({ text: ' ', source: 'wrote' }), /text/);
  assert.throws(() => memory.add({ text: 'a'.repeat(301), source: 'wrote' }), /300/);
  const n = memory.add({ text: 'Old words here', source: 'wrote' });
  memory.edit(n.id, 'New words here');
  assert.deepStrictEqual(filesWith('Old words here'), [], 'an edit keeps no copy of the old words');
  assert.strictEqual(memory.get(n.id).final_text_by, 'user');
  assert.ok(memory.remove(n.id));
  assert.deepStrictEqual(filesWith('New words here'), []);
  const ev = fs.readFileSync(memory.eventsFile(), 'utf8');
  assert.ok(ev.includes(n.id) && !ev.includes('words here'), 'events hold ids, never text');
});

test('the block the model sees: header and labels, newest first, capped; logs get ids and a sha only', () => {
  setOn(); clearNotes();
  const a = memory.add({ text: 'Has a dog called Pip', source: 'told' });
  const b = memory.add({ text: 'Writes code at night', source: 'noticed' });
  const blk = memory.block();
  assert.ok(blk.text.startsWith(`${HEADER}\n`));
  assert.match(blk.text, /- Writes code at night \(you noticed it and they agreed, /);
  assert.match(blk.text, /- Has a dog called Pip \(they told you, /);
  assert.deepStrictEqual(new Set(blk.note_ids), new Set([a.id, b.id]));
  const sys = memory.systemWith('SYSTEM PROMPT', blk);
  assert.ok(sys.startsWith(`SYSTEM PROMPT\n\n${HEADER}`));
  const red = memory.redactMessages([{ role: 'system', content: sys }, { role: 'assistant', content: '',
    tool_calls: [{ function: { name: 'remember', arguments: '{"text":"secret"}' } }] }], blk);
  assert.ok(!JSON.stringify(red).includes('Pip') && !JSON.stringify(red).includes('secret'));
  assert.ok(JSON.stringify(red).includes(a.id));
  for (let i = 0; i < 40; i++) memory.add({ text: `Filler note number ${i} ` + 'z'.repeat(80), source: 'wrote' });
  const big = memory.block();
  assert.ok(big.text.length <= memory.MAX_BLOCK_CHARS && big.omitted > 0);
  setOff(); clearNotes();
});

function fakeModel(seen) {
  return http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => { s += c; });
    req.on('end', () => {
      if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); return res.end('{"data":[]}'); }
      const body = JSON.parse(s); seen.push(body);
      const last = body.messages[body.messages.length - 1];
      const user = (last.content || '');
      let message;
      if (last.role === 'tool') message = { role: 'assistant', content: 'I asked if I may keep that.' };
      else if (/onion/.test(user)) message = { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'remember', arguments: JSON.stringify({ text: NOTE, source: 'told' }) } }] };
      else message = { role: 'assistant', content: 'Here is a soup recipe, without onion, since you prefer recipes that way.' };
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ model: 'fake', usage: { prompt_tokens: 40 }, choices: [{ finish_reason: 'stop', message }] }));
    });
  });
}

async function boot(t, token, trustExtra) {
  setOn(trustExtra); clearNotes();
  const seen = []; const fake = fakeModel(seen);
  await new Promise((r) => fake.listen(7452, '127.0.0.1', r));
  const srv = makeServer(token);
  await new Promise((r) => srv.listen(7451, '127.0.0.1', r));
  t.after(async () => { setOff(); for (const x of [fake, srv]) { x.closeAllConnections(); await new Promise((r) => x.close(r)); } });
  const H = { 'content-type': 'application/json', 'x-lh-token': token };
  const post = async (route, body) => (await fetch('http://127.0.0.1:7451' + route, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })).json();
  const get = async (route) => (await fetch('http://127.0.0.1:7451' + route, { headers: H })).json();
  return { seen, post, get };
}

test('end to end: the model offers, you approve, it sees the note next time, the reply shows it, and forget leaves no copy', async (t) => {
  const { seen, post, get } = await boot(t, 'm'.repeat(48));
  const { conv_id } = await post('/api/new');
  const r1 = await post('/api/send', { conv_id, text: 'please leave the onion out, always' });
  assert.strictEqual(r1.reply.tools[0].name, 'remember');
  assert.strictEqual(r1.reply.tools[0].decision, 'waiting for approval');
  assert.deepStrictEqual(Object.keys(r1.reply.tools[0].args), ['offer'], 'the offer text is not in the reply record');
  assert.strictEqual(seen[1].messages.find((m) => m.role === 'tool').content, memory.WORDING.offer_output);
  let conv = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(conv.approvals.length, 1);
  assert.strictEqual(conv.approvals[0].args.text, NOTE, 'the open offer shows its text to the user');
  assert.strictEqual(memory.list().length, 0, 'nothing saved before a yes');

  const calls = seen.length;
  const ok = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve' });
  assert.strictEqual(ok.note.text, NOTE);
  assert.strictEqual(ok.note.source, 'told');
  assert.strictEqual(ok.note.final_text_by, 'model');
  assert.strictEqual(ok.note.conv_id, conv_id);
  assert.strictEqual(seen.length, calls, 'saving a note asks the model for no new reply');
  const apr = fs.readFileSync(path.join(TMP, 'approvals.jsonl'), 'utf8');
  assert.ok(!apr.includes(NOTE) && apr.includes(ok.note.id), 'the offer record keeps the id, not the text');

  const r2 = await post('/api/send', { conv_id, text: 'Any soup idea for tonight?' });
  const sys = seen[seen.length - 1].messages[0];
  assert.strictEqual(sys.role, 'system');
  assert.ok(sys.content.includes(`- ${NOTE} (they told you,`), 'the model sees the note with its source');
  assert.deepStrictEqual(r2.reply.memory.note_ids, [ok.note.id]);
  assert.deepStrictEqual(r2.reply.memory.likely, [ok.note.id], 'the reply shares the note\'s words');
  conv = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(conv.notes[ok.note.id].text, NOTE, 'the page gets the note to show under the reply');

  // Logs: the memory block and the offer appear as ids, never as text.
  const log = fs.readFileSync(path.join(TMP, 'logs', `${conv_id}.jsonl`), 'utf8');
  assert.ok(log.includes('"memory"') && log.includes(ok.note.id));
  assert.ok(!log.includes(HEADER), 'the block text is not logged');

  // Forget the note: its text is gone from every file the harness keeps.
  assert.ok(filesWith(NOTE).length >= 1);
  await post('/api/memory/delete', { id: ok.note.id });
  assert.deepStrictEqual(filesWith(NOTE), [], 'no copy of the note left anywhere');
  conv = await get(`/api/conv/${conv_id}`);
  assert.strictEqual(conv.notes[ok.note.id], undefined, 'the page shows it as forgotten');

  // Forgetting a chat names the notes that came from it, and leaves them for the user to decide.
  const n2 = memory.add({ text: 'Another invented note', source: 'told', convId: conv_id });
  const f = await post('/api/forget', { conv_id });
  assert.deepStrictEqual(f.notes_from_chat, [n2.id]);
  assert.ok(memory.get(n2.id), 'kept until the user deletes it');
  clearNotes();
});

test('a declined offer keeps nothing; an edited one is saved in your words; every level still asks', async (t) => {
  const { post, get } = await boot(t, 'n'.repeat(48), { memory: 'ask' });
  const { conv_id } = await post('/api/new');
  const r1 = await post('/api/send', { conv_id, text: 'no onion please' });
  assert.strictEqual(r1.reply.tools[0].decision, 'waiting for approval', 'the model must ask at every level');
  let conv = await get(`/api/conv/${conv_id}`);
  await post('/api/approval', { id: conv.approvals[0].id, decision: 'reject' });
  assert.strictEqual(memory.list().length, 0);
  assert.deepStrictEqual(filesWith(NOTE), [], 'nothing of a declined offer is kept');

  await post('/api/send', { conv_id, text: 'onion again' });
  conv = await get(`/api/conv/${conv_id}`);
  const ok = await post('/api/approval', { id: conv.approvals[0].id, decision: 'approve', args: { text: 'Cooks without onion', source: 'told' } });
  assert.strictEqual(ok.note.text, 'Cooks without onion');
  assert.strictEqual(ok.note.final_text_by, 'user');
  const added = await post('/api/memory/add', { text: 'Lives near the sea' });
  assert.strictEqual(added.note.source, 'wrote');
  const listed = await get('/api/memory');
  assert.strictEqual(listed.notes.length, 2);
  assert.strictEqual(listed.status.on, true);
  clearNotes();
});

test('with memory on and no notes yet, the offer tool is there but no system message is sent', async (t) => {
  const { seen, post } = await boot(t, 'p'.repeat(48));
  const { conv_id } = await post('/api/new');
  assert.strictEqual(memory.list().length, 0);
  const r1 = await post('/api/send', { conv_id, text: 'no onion for me' });
  assert.strictEqual(r1.reply.tools[0].name, 'remember');
  assert.strictEqual(r1.reply.memory.live, true);
  assert.ok(!seen[0].messages.some((m) => m.role === 'system'), 'no notes, so no memory block');
  assert.ok(seen[0].tools.some((x) => x.function.name === 'remember'));
  clearNotes();
});

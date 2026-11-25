// node --test test
// The chat menu: pin, rename, archive, forget. Page settings only: nothing the model sees or searches changes.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-menu-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7511';
process.env.LH_MODEL_URL = 'http://127.0.0.1:7512';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'no-system-prompt.txt');

const { makeServer } = require('../src/server');
const H = { 'content-type': 'application/json', 'x-lh-token': 'd'.repeat(48) };
const BASE = 'http://127.0.0.1:7511';
const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: H, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const list = () => fetch(BASE + '/api/conversations', { headers: H }).then((r) => r.json()).then((r) => r.items);

test('pin, rename, archive and unarchive a chat; forget clears its settings', async (t) => {
  const srv = makeServer('d'.repeat(48));
  await new Promise((r) => srv.listen(7511, '127.0.0.1', r));
  t.after(async () => { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); });
  const a = (await post('/api/new', {})).body.conv_id;
  await post('/api/send', { conv_id: a, author: 'user', text: 'What is the capital of France?', reply: false });
  const before = fs.readFileSync(path.join(TMP, 'conversations', `${a}.jsonl`), 'utf8');

  let it = (await list()).find((x) => x.id === a);
  assert.deepStrictEqual([it.title, it.renamed, it.pinned, it.archived], ['What is the capital of France?', false, false, false]);

  await post('/api/chat/meta', { conv_id: a, title: '  Geography   quiz ' });
  await post('/api/chat/meta', { conv_id: a, pinned: true });
  it = (await list()).find((x) => x.id === a);
  assert.deepStrictEqual([it.title, it.renamed, it.pinned], ['Geography quiz', true, true]);

  // Archiving unpins it and hides it in the page; the chat itself is untouched.
  await post('/api/chat/meta', { conv_id: a, archived: true });
  it = (await list()).find((x) => x.id === a);
  assert.deepStrictEqual([it.archived, it.pinned], [true, false]);
  assert.strictEqual(fs.readFileSync(path.join(TMP, 'conversations', `${a}.jsonl`), 'utf8'), before, 'archiving changes nothing in the chat');

  await post('/api/chat/meta', { conv_id: a, archived: false, title: '' });
  it = (await list()).find((x) => x.id === a);
  assert.deepStrictEqual([it.archived, it.renamed, it.title], [false, false, 'What is the capital of France?'], 'an empty name puts the first words back');

  assert.strictEqual((await post('/api/chat/meta', { conv_id: 'c-nope', archived: true })).status, 404);
  assert.strictEqual((await post('/api/chat/meta', { conv_id: a, title: 42 })).status, 400);

  await post('/api/chat/meta', { conv_id: a, title: 'Private name', archived: true });
  await post('/api/forget', { conv_id: a });
  const meta = JSON.parse(fs.readFileSync(path.join(TMP, 'chat-meta.json'), 'utf8'));
  assert.ok(!(a in meta), 'forgetting a chat removes its title and marks too');
});

test('the page: a ⋯ menu per chat with Pin, Rename, Archive, Forget; archived chats in their own closed section', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'public', 'index.html'), 'utf8');
  for (const s of ["it.pinned ? 'Unpin' : 'Pin'", "item('Rename'", "it.archived ? 'Unarchive' : 'Archive'", "item('Forget', () => forgetChat(it.id), 'danger')", "'Archived (' + archived.length + ')'"]) {
    assert.ok(html.includes(s), s);
  }
  assert.match(html, /async function forgetChat\(id\) \{\n    if \(!id \|\| !await askDanger\(/, 'Forget from the menu still asks, Cancel first');
  assert.match(html, /an archived chat never opens by itself/);
  assert.match(html, /const next = items\.find\(\(x\) => x\.pinned && !x\.archived\) \|\| items\.find\(\(x\) => !x\.archived\);/, 'forgetting the open chat never opens an archived one');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(src, /fs\.renameSync\(tmp, CHAT_META\)/, 'written safely');
});

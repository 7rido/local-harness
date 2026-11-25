// node --test test
// A note offer that cannot be saved: if the note is over 300 characters, memory.add throws. The note must be saved
// BEFORE the approval is closed; otherwise the offer's text would stay in approvals.jsonl (outside notes.json, so
// Forget could not reach it) and the approval would be recorded for a note that was never saved. If saving fails,
// the offer stays open.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-approvalfail-test-'));
process.env.LH_DATA = TMP;
process.env.LH_PORT = '7581';
process.env.LH_TRUST_FILE = path.join(TMP, 'trust.json');
process.env.LH_SYSTEM_PROMPT = path.join(TMP, 'none.txt');

const lib = require('../src/lib');
const approvals = require('../src/approvals');
const memory = require('../src/memory');
const { makeServer } = require('../src/server');

const H = { 'content-type': 'application/json', 'x-lh-token': 'a'.repeat(48) };
const BASE = 'http://127.0.0.1:7581';
const post = async (route, body) => { const r = await fetch(BASE + route, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
const offer = (text) => approvals.addApproval({ convId: 'c-test', name: 'remember', args: { text, source: 'told' } });
const rows = () => lib.readJsonl(path.join(TMP, 'approvals.jsonl'));
const everything = () => ['approvals.jsonl', 'logs/c-test.jsonl', 'memory/events.jsonl'].map((f) => { try { return fs.readFileSync(path.join(TMP, f), 'utf8'); } catch { return ''; } }).join('\n');

test('an over-long note: the offer stays open, nothing is saved, and the user can shorten it and approve again', async (t) => {
  const srv = makeServer('a'.repeat(48));
  await new Promise((r) => srv.listen(7581, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));

  const long = `zebra-marker ${'word '.repeat(80)}`;   // over 300 characters
  const apr = offer(long);
  const res = await post('/api/approval', { id: apr.id, decision: 'approve' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /at most 300 characters.*still open/);
  assert.strictEqual(rows().find((x) => x.id === apr.id).status, 'open', 'the offer is still open');
  assert.strictEqual(memory.list().length, 0, 'no note was saved');
  assert.ok(!fs.readFileSync(path.join(TMP, 'logs', 'c-test.jsonl'), 'utf8').includes('zebra-marker'), 'the log has the reason, never the text');
  assert.match(fs.readFileSync(path.join(TMP, 'logs', 'c-test.jsonl'), 'utf8'), /note not saved, offer left open/);

  // The user shortens the words and approves again: it saves, closes, and the offer's text is gone from the record.
  const ok = await post('/api/approval', { id: apr.id, decision: 'approve', args: { text: 'quokka-marker: short enough', source: 'told' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.note.text, 'quokka-marker: short enough');
  assert.strictEqual(ok.body.note.final_text_by, 'user');
  const closed = rows().find((x) => x.id === apr.id);
  assert.deepStrictEqual([closed.status, closed.args], ['approved', { note_id: ok.body.note.id }]);
  assert.ok(!everything().includes('zebra-marker'), 'the long text is in no file');
  assert.ok(!fs.readFileSync(path.join(TMP, 'approvals.jsonl'), 'utf8').includes('quokka-marker'), 'the note\'s text is only in notes.json');
});

test('an empty note is refused the same way, and a good one saves at once', async (t) => {
  const srv = makeServer('a'.repeat(48));
  await new Promise((r) => srv.listen(7581, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  const empty = offer('   ');
  const bad = await post('/api/approval', { id: empty.id, decision: 'approve' });
  assert.deepStrictEqual([bad.status, rows().find((x) => x.id === empty.id).status], [400, 'open']);
  const good = offer('okapi-marker: a fine note');
  const res = await post('/api/approval', { id: good.id, decision: 'approve' });
  assert.deepStrictEqual([res.status, res.body.note.final_text_by], [200, 'model']);
  assert.ok(!fs.readFileSync(path.join(TMP, 'approvals.jsonl'), 'utf8').includes('okapi-marker'));
});

test('declining an offer: closed, its text cleared', async (t) => {
  const srv = makeServer('a'.repeat(48));
  await new Promise((r) => srv.listen(7581, '127.0.0.1', r));
  t.after(() => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }));
  const apr = offer('lemur-marker: declined words');
  const res = await post('/api/approval', { id: apr.id, decision: 'reject' });
  assert.strictEqual(res.status, 200);
  const row = rows().find((x) => x.id === apr.id);
  assert.deepStrictEqual([row.status, row.args], ['rejected', {}]);
  assert.ok(!everything().includes('lemur-marker'));
  // Approving an already-closed offer is not found.
  assert.strictEqual((await post('/api/approval', { id: apr.id, decision: 'approve' })).status, 404);
});

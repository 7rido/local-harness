// Memory: short notes the user keeps for the model. The model asks; the user approves.
//
//   - the model may offer one note mid-chat (the `remember` tool); it is saved only when the user says yes;
//   - the user can also write, edit and really delete notes on the Memory page;
//   - saved notes are added to the system prompt at the start of each chat.
//
// Rules this file keeps:
//   1. One place for note text: <data>/memory/notes.json. Everything else (messages, logs, approvals,
//      events) refers to a note by its id, so deleting a note deletes its text. Edits keep no history.
//   2. Off until the user turns it on: trust.json {"memory": "on"}. Until then notes can be kept and
//      edited on the Memory page, but the model never sees them and has no offer tool.
//   3. Every note says where it came from and who wrote the final words.
//   4. The files live only on this computer. The notes travel only as part of a reply's context to the
//      model server you configured, and in any web search the model writes itself, which is why web_search
//      is off by default and has the never-send list (see websearch.js).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const trust = require('./trust');

const dir = () => path.join(lib.dataDir(), 'memory');
const notesFile = () => path.join(dir(), 'notes.json');
const eventsFile = () => path.join(dir(), 'events.jsonl');

const SOURCES = ['told', 'noticed', 'wrote'];   // the person told the model / the model noticed, the person agreed / the person wrote it
const MAX_NOTE_CHARS = 300;
const MAX_BLOCK_CHARS = 3000;                   // the cap on what is loaded into one chat

// The wording the model sees with its notes. Plain text, edited here.
const WORDING = {
  header: 'Notes the person has agreed you may keep from earlier chats. Each says where it came from. If a note may be out of date, ask before relying on it.',
  told: 'they told you',
  noticed: 'you noticed it and they agreed',
  wrote: 'they wrote it',
  offer_output: 'Your offer is shown to the person, and the note is saved only if they agree. Carry on with your answer; don\'t assume it was saved.',
};

// ---- the switch ----

function switchedOn() { return trust.level('memory') !== 'off'; }

// Why memory is or isn't live, for /api/info and the page.
function status() {
  const on = switchedOn();
  return { on, notes: list().length, why_off: on ? null : 'off in trust.json ("memory": "on" turns it on)' };
}
const live = () => switchedOn();

// ---- the store ----

function load() {
  try { const d = JSON.parse(fs.readFileSync(notesFile(), 'utf8')); return Array.isArray(d.notes) ? d : { version: 1, notes: [] }; }
  catch { return { version: 1, notes: [] }; }
}
function save(d) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${notesFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, notesFile());
}
function event(ev) { lib.appendJsonl(eventsFile(), { ts: new Date().toISOString(), ...ev }); }   // ids only, never text

function clean(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('a note needs some text');
  if (t.length > MAX_NOTE_CHARS) throw new Error(`a note is at most ${MAX_NOTE_CHARS} characters`);
  return t;
}

function list() { return load().notes; }
function get(id) { return list().find((n) => n.id === id) || null; }

// A new note. `by` is who wrote its final words: 'model' (its offer, approved as written) or 'user'.
function add({ text, source, convId = null, offerId = null, by = 'user' }) {
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(', ')}`);
  const d = load();
  const n = { id: lib.newId('mem'), text: clean(text), source, created: new Date().toISOString(), edited: null,
    conv_id: convId, offer_id: offerId, final_text_by: by };
  d.notes.push(n); save(d);
  event({ event: 'add', note_id: n.id, source, by, conv_id: convId, offer_id: offerId });
  return n;
}

// The user changes the words. No history is kept: the old text is gone.
function edit(id, text) {
  const d = load(); const n = d.notes.find((x) => x.id === id);
  if (!n) return null;
  n.text = clean(text); n.edited = new Date().toISOString(); n.final_text_by = 'user';
  save(d); event({ event: 'edit', note_id: id });
  return n;
}

// "Forget that" really deletes: the text exists only in notes.json, so removing it there removes it.
function remove(id) {
  const d = load(); const before = d.notes.length;
  d.notes = d.notes.filter((x) => x.id !== id);
  if (d.notes.length === before) return false;
  save(d); event({ event: 'delete', note_id: id });
  return true;
}

const fromChat = (convId) => list().filter((n) => n.conv_id === convId).map((n) => n.id);

// ---- what the model sees ----

function date(iso) { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }

// The memory block for one chat, or null when memory isn't live or there are no notes. Newest first, capped.
function block() {
  if (!live()) return null;
  const w = WORDING;
  const notes = [...list()].sort((a, b) => (b.edited || b.created).localeCompare(a.edited || a.created));
  const lines = []; const ids = []; let size = w.header.length;
  for (const n of notes) {
    const line = `- ${n.text} (${w[n.source]}, ${date(n.created)})`;
    if (size + line.length + 1 > MAX_BLOCK_CHARS) break;
    lines.push(line); ids.push(n.id); size += line.length + 1;
  }
  if (!ids.length) return null;
  const text = `${w.header}\n${lines.join('\n')}`;
  return { text, note_ids: ids, omitted: notes.length - ids.length, sha: lib.sha256(text) };
}

// The user's system prompt with the memory block after it.
function systemWith(systemPrompt, blk) {
  const own = (systemPrompt || '').trim();
  if (!blk) return own;
  return own ? `${own}\n\n${blk.text}` : blk.text;
}

// For logs: the memory block as ids and a sha, never its text; past-chat search results as a marker; the
// model's note offer as a marker.
function redactMessages(messages, blk, hidden = []) {
  return messages.map((m) => {
    let out = m;
    // Past-chat search results (recall.js): the log keeps ids, which the reply record holds.
    if (m.role === 'tool' && hidden.includes(m.content)) out = { ...out, content: '[past-chat search results: ids in the reply record]' };
    if (blk && m.role === 'system' && typeof m.content === 'string' && m.content.includes(blk.text)) {
      out = { ...out, content: m.content.replace(blk.text, `[memory: ${blk.note_ids.length} notes ${blk.note_ids.join(',')} sha ${blk.sha.slice(0, 12)}]`) };
    }
    if (Array.isArray(m.tool_calls)) {
      out = { ...out, tool_calls: m.tool_calls.map((tc) => (tc.function && tc.function.name === 'remember'
        ? { ...tc, function: { ...tc.function, arguments: '[note offer: text kept only until the person decides]' } } : tc)) };
    }
    return out;
  });
}

// Which loaded notes a reply probably drew on: shared distinctive words. A guess, and the page says so.
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'they', 'your', 'you', 'what', 'when', 'like', 'about', 'their',
  'there', 'would', 'should', 'could', 'which', 'were', 'been', 'into', 'than', 'then', 'them', 'some', 'more', 'also',
  'just', 'very', 'over', 'only', 'does', 'doesn', 'prefers', 'prefer', 'person', 'always', 'never']);
function words(s) { return new Set((String(s || '').toLowerCase().match(/[a-z][a-z'’]{3,}/g) || []).filter((w) => !STOP.has(w))); }
function likelyUsed(replyText, noteIds) {
  const said = words(replyText);
  const out = [];
  for (const id of noteIds || []) {
    const n = get(id); if (!n) continue;
    const ws = [...words(n.text)];
    const shared = ws.filter((w) => said.has(w)).length;
    if (shared >= 2 || (ws.length && shared / ws.length >= 0.5 && shared >= 1)) out.push(id);
  }
  return out;
}

// ---- the model's offer (the remember tool: saved only on the user's yes) ----

function offerOutput() { return WORDING.offer_output; }

module.exports = { SOURCES, MAX_NOTE_CHARS, MAX_BLOCK_CHARS, WORDING, switchedOn, status, live, list, get, add, edit, remove,
  fromChat, block, systemWith, redactMessages, likelyUsed, offerOutput, notesFile, eventsFile };

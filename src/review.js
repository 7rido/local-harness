// The review: the model looks back at its own mistakes, names the kind, and proposes a habit. You decide.
//
//   - who names the kind and the habit: the model proposes, you approve (a card: keep it, change the words, or drop it);
//   - where to look: the misses you marked or the arithmetic check caught, plus the model reads recent chats for
//     corrections and mistakes it admitted;
//   - when: when you press Review. It runs against whichever model server is configured.
//
// Rules this file keeps:
//   1. One copy of the text. A case's details (what went wrong, the kind, the habit) live only in
//      <data>/review/cases.json. Runs are logged as ids and shas (runs.jsonl), never text. Forgetting a chat deletes its
//      cases; a kept habit from it loses every link to the chat, and the page asks whether to delete it.
//   2. A habit exists only after your yes. The model's review replies never enter a conversation.
//   3. Habits reach the model only while review and memory are both on, as a block after the notes in the system message.
//   4. Switched on with trust.json {"review": "on"} and needs {"memory": "on"}.
//   5. A habit is a change in behaviour, and your yes on each card is the only check on it.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib');
const memory = require('./memory');
const recall = require('./recall');
const misses = require('./misses');
const trust = require('./trust');

const dir = () => path.join(lib.dataDir(), 'review');
const casesFile = () => path.join(dir(), 'cases.json');
const runsFile = () => path.join(dir(), 'runs.jsonl');

// The wording the model sees. {n}, {expected}, {expr}, {claimed}, {what} are filled in.
const WORDING = {
  person: 'The person',
  you: 'You (reply {n})',
  find: 'Above is one of your earlier chats with the person. Look for places where you got something wrong: the person corrected you, or you said you had made a mistake. For each one, write a line "MISTAKE <reply number>: <what went wrong, in a few words>". If there are none, write only "NONE".',
  asked: 'The person asked:',
  replied: 'You replied:',
  then: 'The person then said:',
  wrong_marked: 'The person says the right answer is: {expected}',
  wrong_rule: 'A check found that {expr} is {expected}, not {claimed}.',
  wrong_found: 'Looking back, you noted: {what}',
  name: 'That was a mistake. Name the kind of mistake: general enough to happen again in another chat, not just this one case. Then give one habit: something concrete you will do every time, so this kind of mistake doesn\'t happen again. A change in how you work, not a reminder to be careful. Write exactly two lines: "KIND: ..." and "HABIT: ...".',
  habits_header: 'Habits you and the person agreed on, each from a mistake of yours. Follow them.',
};

const MAX_FIELD = 200;            // a kind or a habit
const MAX_MSG = 1500;             // one message in a transcript the model reads
const MAX_TRANSCRIPT = 12000;     // one chat the model reads (the latest part, if longer)
const MAX_PER_CHAT = 5;           // mistakes taken from one chat
const MAX_HABITS_CHARS = 1500;    // habit lines loaded into one chat
const DAY_MS = 24 * 60 * 60 * 1000;

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));

// ---- the store ----

function load() {
  try { const d = JSON.parse(fs.readFileSync(casesFile(), 'utf8')); return Array.isArray(d.cases) ? d : { version: 1, cases: [] }; }
  catch { return { version: 1, cases: [] }; }
}
function save(d) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${casesFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, casesFile());
}
const runs = () => lib.readJsonl(runsFile());
const lastRun = () => runs().filter((r) => r.event === 'done').pop() || null;

// Every case you can see (dropped and deleted ones are kept only as ids, so the same reply isn't offered twice).
const list = () => load().cases.filter((c) => c.status === 'offered' || c.status === 'kept');
const habits = () => load().cases.filter((c) => c.status === 'kept');
const get = (id) => load().cases.find((c) => c.id === id) || null;

function clean(s) {
  const t = String(s || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().replace(/^["'“]|["'”]$/g, '').trim();
  return t.length > MAX_FIELD ? `${t.slice(0, MAX_FIELD - 1).trimEnd()}…` : t;
}

const switchedOn = () => trust.level('review') !== 'off';
const live = () => switchedOn() && memory.live();
function status() {
  const all = load().cases;
  const on = switchedOn(); const mem = memory.live();
  return { on: on && mem, switched_on: on, memory_on: mem,
    offered: all.filter((c) => c.status === 'offered').length, habits: all.filter((c) => c.status === 'kept').length,
    last_run: lastRun(),
    why_off: !on ? 'off in trust.json ("review": "on" turns it on)' : !mem ? 'memory is off (the review needs "memory": "on")' : null };
}

// ---- you decide ----

function decide(id, decision, { kind, habit } = {}) {
  const d = load(); const c = d.cases.find((x) => x.id === id && x.status === 'offered');
  if (!c) return null;
  if (decision === 'drop') {
    // Nothing of it is kept but its ids, so the same reply isn't offered again.
    for (const k of ['what', 'kind', 'habit']) delete c[k];
    c.status = 'dropped'; c.decided = new Date().toISOString();
  } else if (decision === 'keep') {
    const k = clean(kind == null ? c.kind : kind); const h = clean(habit == null ? c.habit : habit);
    if (!k || !h) throw new Error('a habit needs both the kind of mistake and the habit');
    if (k !== c.kind || h !== c.habit) c.final_text_by = 'user';
    c.kind = k; c.habit = h; c.status = 'kept'; c.decided = new Date().toISOString();
  } else throw new Error('decision must be keep or drop');
  save(d);
  return c;
}
function edit(id, { kind, habit }) {
  const d = load(); const c = d.cases.find((x) => x.id === id && x.status === 'kept');
  if (!c) return null;
  const k = clean(kind); const h = clean(habit);
  if (!k || !h) throw new Error('a habit needs both the kind of mistake and the habit');
  c.kind = k; c.habit = h; c.final_text_by = 'user'; c.edited = new Date().toISOString();
  save(d);
  return c;
}
// Forget a habit (or an offered case): the words are deleted; only the ids stay, so it isn't offered again.
function remove(id) {
  const d = load(); const c = d.cases.find((x) => x.id === id && (x.status === 'kept' || x.status === 'offered'));
  if (!c) return false;
  for (const k of ['what', 'kind', 'habit']) delete c[k];
  c.status = 'deleted'; c.decided = new Date().toISOString();
  save(d);
  return true;
}

// Forgetting reaches the review. A case whose chat is gone is deleted outright; a kept habit from it keeps only its
// own words (the kind and the habit), loses every link to the chat, and is returned so the page can ask about it.
// A case whose miss was deleted (the chat still there) is treated the same way.
function prune(convExists) {
  const d = load(); const missIds = new Set(misses.listMisses().map((x) => x.id));
  const askAbout = []; let changed = false;
  d.cases = d.cases.filter((c) => {
    const chatGone = c.conv_id && !convExists(c.conv_id);
    const missGone = c.miss_id && !missIds.has(c.miss_id);
    if (!chatGone && !missGone) return true;
    changed = true;
    if (c.status !== 'kept') return false;
    for (const k of ['conv_id', 'reply_id', 'question_id', 'miss_id', 'what']) delete c[k];
    c.from_forgotten = true; askAbout.push(c.id);
    return true;
  });
  if (changed) save(d);
  return askAbout;
}

// ---- what the model sees in a chat: the kept habits ----

function habitsBlock() {
  if (!live()) return null;
  const hs = [...habits()].sort((a, b) => (b.edited || b.decided).localeCompare(a.edited || a.decided));
  const lines = []; const ids = []; let size = WORDING.habits_header.length;
  for (const h of hs) {
    const line = `- ${h.kind}: ${h.habit}`;
    if (size + line.length + 1 > MAX_HABITS_CHARS) break;
    lines.push(line); ids.push(h.id); size += line.length + 1;
  }
  if (!ids.length) return null;
  const text = `${WORDING.habits_header}\n${lines.join('\n')}`;
  return { text, ids, omitted: hs.length - ids.length, sha: lib.sha256(text) };
}
// For logs: the habits as ids and a sha, never their words.
function redact(messages, hb) {
  if (!hb) return messages;
  return messages.map((m) => (m.role === 'system' && typeof m.content === 'string' && m.content.includes(hb.text)
    ? { ...m, content: m.content.replace(hb.text, `[habits: ${hb.ids.length} ${hb.ids.join(',')} sha ${hb.sha.slice(0, 12)}]`) } : m));
}

// ---- the review run ----

const cut = (s, n) => { const t = String(s || '').trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };

// One chat as the model reads it: the user's turns and its numbered replies. The latest part, if it is long.
function transcript(chat) {
  const w = WORDING;
  const lines = []; const replies = {}; let n = 0;
  for (const m of chat.msgs) {
    if (!(m.text || '').trim()) continue;
    if (m.author === 'model') { n += 1; replies[n] = m; lines.push(`${fill(w.you, { n })}: ${cut(m.text, MAX_MSG)}`); }
    else if (m.author === 'user') lines.push(`${w.person}: ${cut(m.text, MAX_MSG)}`);
    // Tool and teacher turns are left out: the model reads what was said by the user and by itself.
  }
  let text = lines.join('\n\n');
  while (text.length > MAX_TRANSCRIPT && lines.length > 2) { lines.shift(); text = lines.join('\n\n'); }
  return { text, replies };
}
function parseFind(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/MISTAKE\s*#?\s*(\d+)\s*[:\-–]\s*(.+)/gi)) out.push({ n: Number(m[1]), what: clean(m[2]) });
  return out;
}
function parseName(text) {
  const k = String(text || '').match(/^[\s*_-]*KIND[\s*_]*:\s*(.+)$/im);
  const h = String(text || '').match(/^[\s*_-]*HABIT[\s*_]*:\s*(.+)$/im);
  return { kind: k ? clean(k[1]) : '', habit: h ? clean(h[1]) : '' };
}
function caseMessage({ question, reply, next, wrong }) {
  const w = WORDING;
  const parts = [`${w.asked}\n${cut(question, MAX_MSG)}`, `${w.replied}\n${cut(reply, MAX_MSG)}`];
  if (next) parts.push(`${w.then}\n${cut(next, MAX_MSG)}`);
  parts.push(wrong, w.name);
  return parts.join('\n\n');
}

let progress = null;   // { stage, done, total, started } while a run is going
const running = () => Boolean(progress);

// `call(messages)` asks the model once and returns the chat-completion choice. `convExists(id)` says whether a chat is
// still there (forgotten mid-run: nothing is saved for it).
async function run({ call, convExists, info = null, now = Date.now() }) {
  const w = WORDING;
  if (!live()) throw new Error(status().why_off);
  if (progress) throw new Error('a review is already running');
  const runId = lib.newId('rev');
  const last = lastRun();
  const since = last ? last.started : new Date(now - DAY_MS).toISOString();
  progress = { stage: 'reading', done: 0, total: 0, started: new Date().toISOString() };
  const log = (ev) => lib.appendJsonl(runsFile(), { ts: new Date().toISOString(), run_id: runId, ...ev });
  log({ event: 'start', since, wording_sha: lib.sha256(JSON.stringify(WORDING)), model: info });
  const ask = async (content, purpose) => {
    const choice = await call([{ role: 'user', content }]);
    const reply = lib.splitReply(choice);
    // The run log keeps what was asked and answered as shas only (rule 1).
    log({ event: 'model_call', purpose, prompt_sha: lib.sha256(content), reply_sha: lib.sha256(reply.text), finished: reply.finished });
    return reply.text;
  };
  const have = load().cases;
  const seenReply = new Set(have.map((c) => c.reply_id).filter(Boolean));
  const seenMiss = new Set(have.map((c) => c.miss_id).filter(Boolean));
  const found = [];
  try {
    // 1. Misses you marked or the arithmetic check caught.
    for (const x of misses.listMisses()) {
      if (seenMiss.has(x.id) || seenReply.has(x.reply_id) || !convExists(x.conv_id)) continue;
      const wrong = x.check.kind === 'user' ? fill(w.wrong_marked, { expected: cut(x.check.expected, MAX_MSG) })
        : fill(w.wrong_rule, { expr: x.check.detail, expected: x.check.expected, claimed: x.check.claimed });
      found.push({ conv_id: x.conv_id, reply_id: x.reply_id, question_id: x.question_id, miss_id: x.id,
        found_by: x.check.kind === 'user' ? 'you' : 'rule', what: null, question: x.prompt, reply: x.reply, wrong });
      seenReply.add(x.reply_id);
    }
    // 2. The model reads recent chats: anything new since the last review.
    const chats = recall.eligibleChats(null).filter((c) => c.msgs.some((m) => String(m.ts) > since));
    progress.total = chats.length;
    const chatIds = [];
    for (const chat of chats) {
      chatIds.push(chat.id);
      const t = transcript(chat);
      if (Object.keys(t.replies).length) {
        const said = await ask(`${t.text}\n\n${w.find}`, 'find');
        let taken = 0;
        for (const f of parseFind(said)) {
          const m = t.replies[f.n];
          if (!m || seenReply.has(m.id) || taken >= MAX_PER_CHAT) continue;
          const i = chat.msgs.indexOf(m);
          const q = chat.msgs.slice(0, i).reverse().find((x) => x.author === 'user');
          const next = chat.msgs.slice(i + 1).find((x) => x.author === 'user');
          found.push({ conv_id: chat.id, reply_id: m.id, question_id: q ? q.id : null, miss_id: null, found_by: 'model',
            what: f.what, question: q ? q.text : '', reply: m.text, next: next ? next.text : '', wrong: fill(w.wrong_found, { what: f.what }) });
          seenReply.add(m.id); taken += 1;
        }
      }
      progress.done += 1;
    }
    log({ event: 'read', chats: chatIds, found: found.length });
    // 3. For each mistake the model names the kind and offers a habit, in its own words.
    progress.stage = 'naming'; progress.done = 0; progress.total = found.length;
    const made = [];
    for (const f of found) {
      const said = await ask(caseMessage(f), 'name');
      const { kind, habit } = parseName(said);
      progress.done += 1;
      if (!convExists(f.conv_id)) continue;   // the chat was forgotten while the model worked
      const d = load();
      const c = { id: lib.newId('case'), run_id: runId, created: new Date().toISOString(), conv_id: f.conv_id, reply_id: f.reply_id,
        question_id: f.question_id, miss_id: f.miss_id, found_by: f.found_by, ...(f.what ? { what: f.what } : {}),
        kind, habit, status: 'offered', final_text_by: kind && habit ? 'model' : null };
      d.cases.push(c); save(d); made.push(c.id);
    }
    log({ event: 'done', started: progress.started, chats: chatIds, cases: made });
    return { run_id: runId, chats: chatIds, cases: made };
  } catch (err) {
    log({ event: 'failed', detail: String(err.message || err) });
    throw err;
  } finally {
    progress = null;
    prune(convExists);
  }
}

module.exports = { WORDING, live, status, list, habits, get, decide, edit, remove, prune, habitsBlock, redact, run, running,
  progress: () => progress, lastRun, transcript, parseFind, parseName, casesFile, runsFile };

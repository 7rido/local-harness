// Looking back through past chats: the `search_chats` tool. The model searches when something seems
// familiar, and a line under its reply names the chats it looked at.
//
// Rules this file keeps:
//   1. Read-only, plain word matching on this computer: no model, no embeddings, nothing downloaded. The
//      text the model is shown travels only as part of its reply's context, to the model server you configured,
//      and in any web search it writes from it.
//   2. Never the chat the model is in; only the user's words and the model's final replies (never its thinking,
//      tool output or harness text).
//   3. Results reach the model through the search_chats tool; the logs keep only chat and message ids, never
//      the text, so forgetting a chat removes it from every other chat's log too (server.js redacts the tool output).
//   4. Switched off with "search_chats": "off" in trust.json. It is read-only, so "ask" counts as "on".

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const trust = require('./trust');

const convDir = () => path.join(lib.dataDir(), 'conversations');
const MAX_RESULTS = 3;
const MAX_USER = 300;
const MAX_REPLY = 500;

// The wording the model sees with search results. {date}, {user}, {reply} are filled per exchange.
const WORDING = {
  found: 'From your earlier chats with the person, the closest matches (they may be out of date):',
  item: '- {date}: the person said "{user}"; you replied "{reply}"',
  none: 'Nothing in your earlier chats with the person matches that.',
};

const live = () => trust.level('search_chats') !== 'off';

// The chats the model may search: all of them except the current one.
function eligibleChats(exceptConvId) {
  let files = [];
  try { files = fs.readdirSync(convDir()).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const id = f.slice(0, -6);
    if (id === exceptConvId) continue;
    const msgs = lib.readJsonl(path.join(convDir(), f));
    if (!msgs.length) continue;
    out.push({ id, msgs });
  }
  return out;
}

// One exchange = a user turn and the model's next reply.
function exchanges(chat) {
  const out = [];
  for (let i = 0; i < chat.msgs.length; i++) {
    const q = chat.msgs[i];
    if (q.author !== 'user' || !(q.text || '').trim()) continue;
    const a = chat.msgs.slice(i + 1).find((m) => m.author === 'model' || m.author === 'user');
    const reply = a && a.author === 'model' ? a : null;
    out.push({ conv_id: chat.id, user_id: q.id, reply_id: reply ? reply.id : null, ts: q.ts,
      user: q.text.trim(), reply: reply ? (reply.text || '').trim() : '' });
  }
  return out;
}

const STOP = new Set(['what', 'that', 'this', 'with', 'have', 'from', 'your', 'about', 'there', 'their', 'would', 'could',
  'should', 'which', 'when', 'where', 'were', 'been', 'they', 'them', 'then', 'than', 'into', 'just', 'like', 'some',
  'more', 'also', 'very', 'does', 'did', 'you', 'and', 'the', 'for', 'are', 'was', 'but', 'not', 'can', 'all', 'any',
  'how', 'why', 'who', 'our', 'out', 'had', 'has', 'his', 'her', 'its', 'one', 'two', 'yes', 'okay', 'please', 'thanks',
  'know', 'think', 'want', 'tell', 'said', 'say', 'remember', 'time', 'talked', 'talk', 'chat', 'earlier', 'before']);
function terms(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9'’]{2,}/g) || []).map((w) => w.replace(/['’]s$/, '')).filter((w) => !STOP.has(w));
}
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// The best matches for one query: shared distinctive words (rarer words count more), newer first on ties.
function search(query, { exceptConvId = null, limit = MAX_RESULTS } = {}) {
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  const all = eligibleChats(exceptConvId).flatMap(exchanges);
  const docs = all.map((x) => new Set(terms(`${x.user}\n${x.reply}`)));
  const df = (w) => docs.reduce((n, d) => n + (d.has(w) ? 1 : 0), 0);
  const idf = Object.fromEntries(q.map((w) => [w, Math.log(1 + all.length / (1 + df(w)))]));
  return all.map((x, i) => ({ x, score: q.reduce((s, w) => s + (docs[i].has(w) ? idf[w] : 0), 0),
    shared: q.filter((w) => docs[i].has(w)).length }))
    .filter((r) => r.shared > 0)
    .sort((a, b) => b.score - a.score || String(b.x.ts).localeCompare(String(a.x.ts)))
    .slice(0, limit).map((r) => ({ ...r.x, score: r.score }));
}

function date(iso) { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }

// What the model is told.
function render(results) {
  const w = WORDING;
  if (!results.length) return w.none;
  const items = results.map((r) => w.item.replace('{date}', date(r.ts)).replace('{user}', cut(r.user, MAX_USER))
    .replace('{reply}', cut(r.reply || '—', MAX_REPLY)));
  return `${w.found}\n${items.join('\n')}`;
}

// The ids only, for logs and the page.
const refs = (results) => results.map((r) => ({ conv_id: r.conv_id, user_id: r.user_id, reply_id: r.reply_id, ts: r.ts }));

module.exports = { MAX_RESULTS, MAX_USER, WORDING, live, eligibleChats, exchanges, terms, search, render, refs, cut };

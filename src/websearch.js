// Web search for the model, through DuckDuckGo's plain HTML page (no key). One search returns up to 5
// results: title, link and a short excerpt.
//
// The search log: <data>/searches.jsonl, one line per search, and searches.md to read. When, which chat, the
// words the model searched for, how it got there (the thinking just before the call, whether it was a
// proper call or one written into its text, which search of this reply it was and what it searched before
// it), what came back (titles and links), and afterwards which of those links its answer named. Forgetting a
// chat deletes its searches here too.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const URL_DDG = () => process.env.LH_SEARCH_URL || 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 5;
const TIMEOUT_MS = 10000;
// A generic client name: nothing about the user or this project leaves the computer except the search words.
const USER_AGENT = 'Mozilla/5.0 (compatible)';
const file = () => path.join(lib.dataDir(), 'searches.jsonl');
const mdFile = () => path.join(lib.dataDir(), 'searches.md');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', pound: '£', euro: '€', copy: '©', reg: '®', deg: '°', middot: '·' };
function text(html) {
  return String(html || '').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] != null) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
      return m;
    }).replace(/\s+/g, ' ').trim();
}
// DuckDuckGo's links may come wrapped in its redirect (//duckduckgo.com/l/?uddg=<the link>).
function realUrl(href) {
  const h = text(href);
  const m = h.match(/[?&]uddg=([^&]+)/);
  const u = m ? decodeURIComponent(m[1]) : h.startsWith('//') ? 'https:' + h : h;
  return /^https?:\/\//.test(u) ? u : null;
}

// The results on one DuckDuckGo HTML page: [{ title, url, snippet }], ads skipped.
function parse(html) {
  const out = [];
  const blocks = String(html).split(/<div class="result[ "]/).slice(1);
  for (const b of blocks) {
    if (/result--ad|badge--ad/.test(b.slice(0, 200))) continue;
    const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/) || b.match(/<a[^>]*href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = realUrl(a[1]);
    if (!url) continue;
    const s = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    out.push({ title: text(a[2]), url, snippet: s ? text(s[1]) : '' });
  }
  return out;
}

// ---- the search guard ----
// Checked in code before anything is sent; a refused search never leaves the computer. It refuses a search that has:
//   - the user's name or OS username, or a word from "search_never_send" in trust.json (the user's own list), in any
//     case, spacing or punctuation ("jdoe", "J Doe", "j.d.o.e" all match; a word under 4 letters must match whole);
//   - three words in a row copied from the system prompt or from a saved note, when at least two of the three are
//     real words (4+ letters, not a common little word), so "in the morning" alone never blocks;
//   - a word with a digit, 3+ characters, from those texts (dates, phone or house numbers); years 2000-2099 excepted,
//     since searches name them all the time; and a number of 7+ digits from those texts however it is split up
//     (555-123-4567 matches 5551234567).
// A single ordinary word from a note never blocks, so a search for a product name still goes out.
const LITTLE = new Set(('the a an and or but of to in on at for with from by as is are was were be been being it its this that these '
  + 'those you your yours he him his she her they them their we us our i me my mine not no do does did done have has had will would '
  + 'can could should may might must about into over under than then so if when what which who whom how why where all any some more '
  + 'most very just also only even still each every other such own same both few many much here there out up down off again once').split(' '));
const words = (s) => String(s || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
function guard(query, { names = [], never = [], texts = [] } = {}) {
  const q = words(query); const qJoined = q.join(''); const qSet = new Set(q); const qLine = ` ${q.join(' ')} `;
  const qDigits = String(query || '').replace(/\D/g, '');
  for (const [list, kind] of [[names, 'name'], [never, 'private']]) {
    for (const n of list) {
      const w = words(n); const c = w.join('');
      if (!c) continue;
      if (c.length >= 4 ? qJoined.includes(c) : qLine.includes(` ${w.join(' ')} `)) return { kind, matched: String(n) };
    }
  }
  // texts: strings, or { id, text } so a match can name the note by id (the search log keeps ids, never note words).
  for (const t of texts) {
    const id = typeof t === 'object' && t ? t.id || null : null;
    const w = words(typeof t === 'object' && t ? t.text : t);
    for (const x of w) {
      if (x.length >= 3 && /\d/.test(x) && !/^20\d\d$/.test(x) && qSet.has(x)) return { kind: 'note', matched: x, note_id: id };
    }
    // A number of 7+ digits (a phone number), however it is split up: compared by its digits alone.
    const raw = typeof t === 'object' && t ? t.text : t;
    for (const m of String(raw || '').match(/\d[\d\s().+-]{5,}\d/g) || []) {
      const d = m.replace(/\D/g, '');
      if (d.length >= 7 && qDigits.includes(d)) return { kind: 'note', matched: m.trim(), note_id: id };
    }
    for (let i = 0; i + 3 <= w.length; i++) {
      const run = w.slice(i, i + 3);
      if (run.filter((x) => x.length >= 4 && !LITTLE.has(x)).length < 2) continue;
      if (qLine.includes(` ${run.join(' ')} `)) return { kind: 'note', matched: run.join(' '), note_id: id };
    }
  }
  return null;
}
// What the model reads when a search is held back. The matched words are the model's own.
const blockedText = (g) => `That search was not sent: it had words about the person (${g.matched}). Search again without them, or ask the person.`;
const isHeldBackText = (s) => /^That search was not sent: it had words about the person \(/.test(s);

// What the model reads: this format, "No results." and, in tools.js, "The search did not work".
function render(results) {
  if (!results.length) return 'No results.';
  return results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}${r.snippet ? '\n' + r.snippet : ''}`).join('\n\n');
}

// The pause: after DuckDuckGo's bot check, nothing is sent for 30 minutes (hammering a site that has just
// challenged you only makes it worse). Kept in a file, so a restart doesn't start sending again early.
const PAUSE_MS = 30 * 60 * 1000;
const pauseFile = () => path.join(lib.dataDir(), 'search-pause.json');
function pausedUntil() { try { const t = JSON.parse(fs.readFileSync(pauseFile(), 'utf8')).until; return t > Date.now() ? t : null; } catch { return null; } }
function pause(now = Date.now()) {
  fs.mkdirSync(path.dirname(pauseFile()), { recursive: true });
  fs.writeFileSync(pauseFile(), JSON.stringify({ until: now + PAUSE_MS, since: new Date(now).toISOString(), why: 'DuckDuckGo bot check' }));
}

async function searchDuckDuckGo(query, { fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return { ok: false, error: 'no search words', results: [], seconds: 0 };
  const until = pausedUntil();
  if (until) return { ok: false, paused: true, error: `not sent: search paused after DuckDuckGo's bot check, until ${new Date(until).toISOString().slice(11, 16)} UTC`, results: [], seconds: 0 };
  try {
    const res = await fetchImpl(URL_DDG(), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
      body: new URLSearchParams({ q }).toString(), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `search page answered ${res.status}`, results: [], seconds: (Date.now() - t0) / 1000 };
    const html = await res.text();
    const results = parse(html).slice(0, MAX_RESULTS);
    // A page with no results and no "no results" notice is a block or a changed layout, not an empty search.
    // DuckDuckGo's bot check (status 202, an "anomaly" page) is never worked around: the search fails and the log
    // says why. Detected by its markup, or "anomaly" on a 202 page; not the bare word on a normal page, because
    // DuckDuckGo echoes the query, so a search for "magnetic anomaly" with no results must not pause searching.
    if (!results.length && (/anomaly-modal|challenge-form/i.test(html) || (res.status === 202 && /anomaly/i.test(html)))) {
      pause();
      return { ok: false, error: "DuckDuckGo showed its bot check instead of results", results: [], seconds: (Date.now() - t0) / 1000 };
    }
    if (!results.length && !/no-results|No results found|No more results/i.test(html)) {
      return { ok: false, error: 'the search page did not look like a results page', results: [], seconds: (Date.now() - t0) / 1000 };
    }
    return { ok: true, results, seconds: (Date.now() - t0) / 1000 };
  } catch (err) {
    return { ok: false, error: err.name === 'TimeoutError' ? 'no answer within 10 seconds' : 'could not reach the search page', results: [], seconds: (Date.now() - t0) / 1000 };
  }
}

// One search: DuckDuckGo only. The result says which provider answered.
async function search(query, { fetchImpl = fetch } = {}) {
  const ddg = await searchDuckDuckGo(query, { fetchImpl });
  return { ...ddg, provider: ddg.paused ? null : 'duckduckgo-html' };
}

// ---- the search log ----
function log(rec) {
  const r = { id: lib.newId('web'), ts: new Date().toISOString(), ...rec };
  lib.appendJsonl(file(), r);
  writeMd();
  return r;
}
// After the reply is saved: which result links (or their sites) the answer named.
function noteOutcome(ids, replyText) {
  if (!ids.length) return;
  const t = String(replyText || '').toLowerCase();
  const all = lib.readJsonl(file());
  for (const r of all) {
    if (!ids.includes(r.id)) continue;
    const named = (r.results || []).filter((x) => { try { return t.includes(x.url.toLowerCase()) || t.includes(new URL(x.url).hostname.replace(/^www\./, '')); } catch { return false; } });
    r.answer_named = named.map((x) => x.url);
  }
  fs.writeFileSync(file(), all.map((x) => JSON.stringify(x)).join('\n') + (all.length ? '\n' : ''));
  writeMd();
}
function forget(convId) {
  const all = lib.readJsonl(file());
  const keep = all.filter((r) => r.conv_id !== convId);
  if (keep.length === all.length) return 0;
  fs.writeFileSync(file(), keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''));
  writeMd();
  return all.length - keep.length;
}
function list() { return lib.readJsonl(file()); }
function writeMd() {
  const rows = list();
  const lines = ['# Web searches', '', 'Newest first. Written by the harness.', ''];
  for (const r of [...rows].reverse()) {
    lines.push(`## ${r.ts.replace('T', ' ').slice(0, 19)} UTC · chat ${r.conv_id}`, '');
    if (r.held_back) {
      // Held back: no query and no matched words are kept (one copy of a note's words, in notes.json; memory.js rule 1).
      const why = r.blocked.kind === 'name' ? 'your name' : r.blocked.kind === 'private' ? 'a word from your never-send list'
        : `words from ${r.blocked.note_id === 'system-prompt' ? 'your system prompt' : `a saved note (${r.blocked.note_id})`}`;
      lines.push(`- **Not sent:** the search guard found ${why}. The search words are not kept here.`, '');
      continue;
    }
    lines.push(`- **Searched for:** ${r.query}`);
    lines.push(`- **How:** search ${r.how.nth} of this reply${r.how.before.length ? ` (before it: ${r.how.before.map((q) => `"${q}"`).join(', ')})` : ''}; ${r.how.call}`);
    if (r.how.thinking_before) lines.push(`- **Thinking just before:** ${r.how.thinking_before.replace(/\s+/g, ' ')}`);
    lines.push(`- **Result:** ${r.ok ? `${r.results.length} results in ${r.seconds.toFixed(1)} s` : `failed (${r.error})`}`);
    for (const x of r.results || []) { lines.push(`  - ${x.title} — ${x.url}`); if (x.snippet) lines.push(`    > ${x.snippet.replace(/\s+/g, ' ')}`); }
    if (r.answer_named) lines.push(`- **The answer named:** ${r.answer_named.length ? r.answer_named.join(', ') : 'none of these links or sites'}`);
    lines.push('');
  }
  fs.mkdirSync(path.dirname(mdFile()), { recursive: true });
  fs.writeFileSync(mdFile(), lines.join('\n'));
}

module.exports = { search, searchDuckDuckGo, pausedUntil, PAUSE_MS, parse, render, guard, blockedText, isHeldBackText, log, noteOutcome, forget, list, MAX_RESULTS };

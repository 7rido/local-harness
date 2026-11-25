#!/usr/bin/env node
// local-harness: a chat page, a tool loop and an activity log for a local model. No npm dependencies.
//
//   LH_MODEL_URL=http://127.0.0.1:8080 node src/server.js     then open the printed http://127.0.0.1:8787/?t=... link
//   node src/server.js --check                                only check that the model server answers
//
// Talks to any OpenAI-compatible /v1/chat/completions server at LH_MODEL_URL.
// Binds 127.0.0.1 by default and requires a token on every request. LH_HOST can add one
// private address so another device can open the chat; see bind.js.

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const lib = require('./lib');
const tools = require('./tools');
const trust = require('./trust');
const approvals = require('./approvals');
const bind = require('./bind');
const memory = require('./memory');
const { readCompletion } = require('./stream');
const websearch = require('./websearch');
const webfetch = require('./webfetch');
const sandbox = require('./sandbox');
const review = require('./review');
const misses = require('./misses');
const asks = require('./asks');
const teacher = require('./teacher');
const thinkharder = require('./thinkharder');

const PORT = Number(process.env.LH_PORT || 8787);
const MODEL_URL = (process.env.LH_MODEL_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
// Some servers (Ollama, LM Studio, vLLM) need a model name in every request; mlx_lm.server and llama.cpp do not.
const MODEL_NAME = process.env.LH_MODEL_NAME || '';
const MAX_TOKENS = Number(process.env.LH_MAX_TOKENS || 4096);
const SAMPLING = {
  temperature: Number(process.env.LH_TEMPERATURE || 0.7),
  top_p: Number(process.env.LH_TOP_P || 0.95),
  // top_k is not part of the OpenAI API, so it is sent only when asked for.
  ...(Number(process.env.LH_TOP_K) > 0 ? { top_k: Number(process.env.LH_TOP_K) } : {}),
};
const TEMPERATURE = SAMPLING.temperature;
const MODEL_TIMEOUT_MS = Number(process.env.LH_MODEL_TIMEOUT_MS || 20 * 60 * 1000);

const DATA = lib.dataDir();
const CONV_DIR = path.join(DATA, 'conversations');
const LOG_DIR = path.join(DATA, 'logs');
const TOKEN_FILE = path.join(DATA, 'token');

const convFile = (id) => path.join(CONV_DIR, `${id}.jsonl`);
const logFile = (id) => path.join(LOG_DIR, `${id}.jsonl`);
const logMdFile = (id) => path.join(LOG_DIR, `${id}.md`);
const validConvId = (id) => typeof id === 'string' && /^c-[0-9A-Za-z-]+$/.test(id);

// A card of numbers the user has verified themselves (a local emergency number, a clinic). Shown on sensitive
// replies, and counted as a source by the number check.
const EMERGENCY_CARD_FILE = process.env.LH_EMERGENCY_CARD || path.join(lib.projectRoot(), 'emergency_card.txt');
function emergencyCard() {
  try { return fs.readFileSync(EMERGENCY_CARD_FILE, 'utf8').trim() || null; } catch { return null; }
}
const systemPrompt = () => lib.systemPrompt();

// The sidebar's per-chat settings: a title the user gave it, pinned, archived. Page settings only:
// archiving hides a chat from the list and keeps everything.
const CHAT_META = path.join(DATA, 'chat-meta.json');
function chatMeta() { try { return JSON.parse(fs.readFileSync(CHAT_META, 'utf8')); } catch { return {}; } }
function setChatMeta(id, change) {
  const all = chatMeta();
  const m = { ...(all[id] || {}), ...change };
  for (const k of Object.keys(m)) if (m[k] == null || m[k] === false || m[k] === '') delete m[k];
  if (Object.keys(m).length) all[id] = m; else delete all[id];
  fs.mkdirSync(DATA, { recursive: true });
  // Written to a temporary file and renamed, so a crash mid-write never leaves a broken file that would drop every
  // name, pin and mark at the next write.
  const tmp = `${CHAT_META}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, CHAT_META);
  return all[id] || {};
}

function logEvent(convId, event) {
  const e = { ts: new Date().toISOString(), conv_id: convId, ...event };
  lib.appendJsonl(logFile(convId), e);
  fs.writeFileSync(logMdFile(convId), lib.renderLogMarkdown(convId, lib.readJsonl(logFile(convId))));
  return e;
}

function addMessage(convId, author, text, extra) {
  const m = lib.makeMessage({ convId, author, text, extra });
  lib.appendJsonl(convFile(convId), m);
  logEvent(convId, { type: 'message', author, source: m.source, text, message_id: m.id });
  return m;
}

// One model call at a time: a local model server usually holds one copy of the model.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// Is the model server answering? Also learns the model's name from /v1/models (shown on the page and in the log).
let lastModelId = null;
async function pingModel() {
  try {
    const res = await fetch(`${MODEL_URL}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { up: false, id: lastModelId };
    try { const j = await res.json(); const id = j && Array.isArray(j.data) && j.data[0] && j.data[0].id; if (id) lastModelId = String(id); } catch {}
    return { up: true, id: lastModelId };
  } catch { return { up: false, id: lastModelId }; }
}
const modelInfo = () => ({ id: MODEL_NAME || lastModelId || null });

// The model's reply while it writes it: conv id -> what the page shows. Never logged or saved; the saved
// reply comes from the whole body, and this is cleared once it is saved.
const liveReplies = new Map();
const RAW_CALL_BLOCK = /<tool_call>[\s\S]*?<\/tool_call>/g;
// The page's live view: thinking and answer so far, split the way the saved reply is split. A tool call the
// model is still writing is cut off, as the saved reply drops it.
function liveView(parts, d, toolNames) {
  let thinking = d.reasoning || ''; let text = d.content || '';
  if (!thinking && /^\s*<think>/.test(text)) {
    const i = text.indexOf('</think>');
    thinking = (i >= 0 ? text.slice(0, i) : text).replace(/^\s*<think>/, '');
    text = i >= 0 ? text.slice(i + '</think>'.length) : '';
  }
  text = text.replace(RAW_CALL_BLOCK, '');
  const open = text.indexOf('<tool_call'); if (open >= 0) text = text.slice(0, open);
  thinking = thinking.replace(RAW_CALL_BLOCK, '');
  return { thinking: [...parts, thinking.trim()].filter(Boolean).join('\n\n— (after tool) —\n\n'), text: text.trim(),
    tools: toolNames, updated: Date.now() };
}

// A search the guard held back: the logged request keeps neither the search words nor the matched words.
// The model still saw both; only the activity log's copy changes.
function redactHeldBack(messages) {
  const held = new Set(messages.filter((m) => m.role === 'tool' && typeof m.content === 'string'
    && (websearch.isHeldBackText(m.content) || /^That (?:page was not opened: its address|question was not sent: it) had words about the person \(/.test(m.content)))
    .map((m) => m.tool_call_id));
  if (!held.size) return messages;
  return messages.map((m) => {
    if (m.role === 'tool' && held.has(m.tool_call_id)) return { ...m, content: '[search held back: words not kept]' };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((c) => held.has(c.id))) {
      return { ...m, tool_calls: m.tool_calls.map((c) => (held.has(c.id)
        ? { ...c, function: { ...c.function, arguments: JSON.stringify((() => { const a = JSON.parse(c.function.arguments || '{}') || {};
          return a.url != null ? { url_sha: lib.sha256(String(a.url)) } : a.question != null ? { question_sha: lib.sha256(String(a.question)) } : { query_sha: lib.sha256(String(a.query || '')) }; })()) } } : c)) };
    }
    return m;
  });
}

async function callModel(convId, messages, info, { withTools = true, memBlock = null, habBlock = null, hidden = [], onDelta = null } = {}) {
  const offered = withTools ? tools.offeredSchemas() : [];
  logEvent(convId, {
    // The memory block and the model's note offers are logged as ids and a sha, never as text (memory.js rule 1).
    type: 'model_call', messages: redactHeldBack(review.redact(memory.redactMessages(messages, memBlock, hidden), habBlock)), messages_sha: lib.sha256(JSON.stringify(messages)),
    ...(memBlock ? { memory: { note_ids: memBlock.note_ids, sha: memBlock.sha, omitted: memBlock.omitted } } : {}),
    ...(habBlock ? { habits: { ids: habBlock.ids, sha: habBlock.sha, omitted: habBlock.omitted } } : {}),
    model: info, temperature: TEMPERATURE, sampling: SAMPLING, max_tokens: MAX_TOKENS,
    tools_offered: offered.map((s) => s.function.name), trust: tools.trustLevels(),
  });
  // A connection can drop before any text arrives. The log keeps the cause code, how long the request was open
  // and whether any text had come; a call that dropped before any text came is sent once more, which is safe since
  // nothing of the reply existed yet.
  for (let attempt = 0; ; attempt++) {
    const opened = Date.now(); let got = 0;
    let lastPiece = opened;
    const counting = (d) => { got += 1; lastPiece = Date.now(); if (onDelta) onDelta(d); };
    try {
      return await callModelOnce(messages, offered, counting);
    } catch (err) {
      const cause = err && err.cause ? (err.cause.code || err.cause.name || String(err.cause.message || '')) : '';
      const dropped = /terminated|other side closed|socket|ECONNRESET|EPIPE/i.test(`${err.message} ${cause}`) && err.name !== 'TimeoutError';
      const retry = dropped && got === 0 && attempt === 0;
      logEvent(convId, { type: 'harness', event: retry ? 'model call dropped, sent again' : 'model call failed', detail: String(err.message || err),
        cause: cause || null, seconds_open: Math.round((Date.now() - opened) / 100) / 10, pieces_received: got,
        stream_end: err.streamEnd || null, seconds_since_last_piece: Math.round((Date.now() - lastPiece) / 100) / 10 });
      if (!retry) throw err;
    }
  }
}

// A model server that goes silent (dead, or its link gone) would hold the call open until the overall cap:
// nothing, not even keep-alive lines, for this long ends the call as a failure.
const MODEL_STALL_MS = Number(process.env.LH_MODEL_STALL_MS || 240000);
async function callModelOnce(messages, offered, onDelta) {
  const ctrl = new AbortController(); let stallTimer;
  const poke = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(new Error(`the model server sent nothing for ${Math.round(MODEL_STALL_MS / 1000)} seconds`)), MODEL_STALL_MS); };
  poke();
  try {
    const res = await fetch(`${MODEL_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Streamed so the page can show the model's thinking as it writes it; readCompletion rebuilds the same body the
      // server sends with stream: false, so the records are unchanged.
      body: JSON.stringify({ ...(MODEL_NAME ? { model: MODEL_NAME } : {}), messages, max_tokens: MAX_TOKENS, ...SAMPLING,
        stream: true, stream_options: { include_usage: true }, ...(offered.length ? { tools: offered } : {}) }),
      signal: AbortSignal.any([AbortSignal.timeout(MODEL_TIMEOUT_MS), ctrl.signal]),
    });
    if (!res.ok) throw new Error(`model server answered ${res.status}`);
    return await readCompletion(res, onDelta || undefined, poke);
  } finally { clearTimeout(stallTimer); }
}

const toolLimitText = () =>
  `You've used the tool ${tools.MAX_CALLS} times for this reply, which is the limit. Answer now without it, and say plainly what you could not check.`;
// No answer text and not cut off: what the model said would be blank (after splitReply, as the reply is saved).
function blankReply(choice) {
  const msg = (choice && choice.message) || {};
  const r = lib.splitReply({ ...choice, message: { ...msg, content: (msg.content || '').replace(RAW_CALL_BLOCK, ''),
    reasoning: (msg.reasoning || '').replace(RAW_CALL_BLOCK, '') } });
  return !r.text && r.finishReason !== 'length';
}

// The last reply that failed in each chat, for the page ("The model couldn't answer: …"); cleared by the next reply or
// the next message. Page only, never in the model's context.
const replyFailed = new Map();
function failReason(err) {
  const m = `${String((err && err.message) || err || '')} ${err && err.cause ? (err.cause.code || '') : ''}`;
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH/i.test(m) && !/terminated|other side closed/i.test(m)) return `the model server is not reachable at ${MODEL_URL}`;
  if (/terminated|other side closed|socket|ECONNRESET/i.test(m)) return 'the connection to the model server dropped';
  if (/sent nothing for/i.test(m)) return 'the model server went silent';
  if (/timeout|aborted due to timeout/i.test(m)) return 'the model took too long';
  if (/model server answered/i.test(m)) return String(err.message);
  if (/stream ended/i.test(m)) return 'the model server stopped before the reply was finished';
  return 'something went wrong';
}
// Think harder: conv id -> { stage, done, total, started, repair } while a run is going, and the set of chats with one
// queued or running (the page shows the progress line from these).
const thinkProgress = new Map();
const thinking = new Set();

async function askModel(convId, opts = {}) {
  if (opts.thinkHarder) thinking.add(convId);
  try { const saved = await answer(convId, opts); replyFailed.delete(convId); return saved; }
  catch (err) { replyFailed.set(convId, { reason: failReason(err), ts: new Date().toISOString() }); throw err; }
  finally { liveReplies.delete(convId); if (opts.thinkHarder) { thinking.delete(convId); thinkProgress.delete(convId); } }
}

// Think harder on one question: 8 tries, the model's own test inputs, the sandbox, the pick (thinkharder.js). Resolves
// { ok: false, reason } without drawing anything when the sandbox is not there, so the reply can be a normal one.
async function runThinkHarder(convId, messages, history, { repair }) {
  const dock = await sandbox.available();
  if (!dock.ok) return { ok: false, reason: `the sandbox is not available (${dock.why}), so the tries could not be checked` };
  const started = Date.now();
  const total = thinkharder.TRIES + 1;
  thinkProgress.set(convId, { stage: 'starting', done: 0, total, started, repair });
  logEvent(convId, { type: 'harness', event: 'think harder started', detail: repair ? 'repair on' : 'repair off' });
  const prompt = history.filter((x) => x.author === 'user').map((x) => x.text).join('\n');
  const r = await thinkharder.think({ messages, prompt, repair,
    draw: async (m) => { const b = await callModelOnce(m, [], null); return (b.choices && b.choices[0]) || {}; },
    onProgress: (p) => thinkProgress.set(convId, { ...p, started, repair }) });
  const { choice, ...rest } = r;
  // Every try, the test inputs and the checks go to the activity log; the chat keeps the reply that is shown.
  logEvent(convId, { type: 'think_harder', messages_sha: lib.sha256(JSON.stringify(messages)), result: rest });
  thinkProgress.set(convId, { ...(thinkProgress.get(convId) || {}), stage: r.ok ? 'saving' : 'fallback', reason: r.ok ? '' : r.reason });
  return r;
}

// What the reply records about a think-harder run (the page shows it under the reply).
function thinkHarderFacts(r, repairOn) {
  if (!r.ok) return { ran: false, reason: r.reason };
  return { ran: true, tries: r.tries, pick: r.pick, why: r.why, inputs: r.inputs.length, survivors: r.survivors.length,
    repair_on: Boolean(repairOn), repaired: Boolean(r.repaired), seconds: r.seconds };
}

// A tool's web search or page read goes to its own log; returns the search log id (or null).
function logWeb(convId, call, outcome, { how = null } = {}) {
  if (call.name === 'web_fetch' && outcome.fetch) {
    webfetch.log(outcome.fetch.blocked
      ? { conv_id: convId, held_back: true, sent: false, blocked: outcome.fetch.blocked, url_sha: lib.sha256(outcome.fetch.url) }
      : { conv_id: convId, url: outcome.fetch.url, final_url: outcome.fetch.final_url || null, ok: outcome.fetch.ok, status: outcome.fetch.status || null,
        bytes: outcome.fetch.bytes || null, text_sha: outcome.fetch.sha || null, truncated: Boolean(outcome.fetch.truncated), error: outcome.fetch.error || null,
        seconds: outcome.seconds || 0 });
    return null;
  }
  if (call.name === 'web_search' && outcome.web) {
    const h = how || { call: 'a tool call', nth: 1, before: [], thinking_before: '' };
    // A held-back search keeps no query, no matched words and no thinking: they may hold a note's words, and a note's
    // text lives in one place only, so forgetting it removes it (memory.js rule 1). A sha says it was the same search.
    const rec = outcome.web.blocked
      ? websearch.log({ conv_id: convId, held_back: true, sent: false, provider: null, blocked: outcome.web.blocked,
        query_sha: lib.sha256(outcome.web.query), how: { call: h.call, nth: h.nth }, ok: false, error: outcome.web.error, seconds: 0, results: [] })
      : websearch.log({ conv_id: convId, query: outcome.web.query, how: h, provider: outcome.web.paused ? null : (outcome.web.provider || 'duckduckgo-html'),
        sent: !outcome.web.paused, ok: outcome.web.ok, error: outcome.web.error, seconds: outcome.seconds || 0,
        results: outcome.web.results.map((x) => ({ title: x.title, url: x.url, snippet: String(x.snippet || '').slice(0, 300) })) });
    return rec.id;
  }
  return null;
}

async function answer(convId, { withTools = true, thinkHarder: th = false, repair = false } = {}) {
  const history = lib.readJsonl(convFile(convId));
  // The approved notes go after the system prompt, only when memory is on.
  const memBlock = memory.block();
  const memLive = memory.live();
  // The habits you kept (review.js) go after the notes, only while review and memory are both on.
  const habBlock = review.habitsBlock();
  const withNotes = memory.systemWith(systemPrompt(), memBlock);
  const sys = habBlock ? (withNotes ? `${withNotes}\n\n${habBlock.text}` : habBlock.text) : withNotes;
  const messages = lib.buildModelMessages(history, sys);
  const info = modelInfo();
  const asked = [...history].reverse().find((x) => x.author !== 'model'); // what the model is answering
  const t0 = Date.now();
  const toolLog = [];
  const thinkingParts = [];
  // Raw tool-call markup the harness takes out of the saved words: the reply is then marked
  // raw_call_removed, so a later readout knows it is not exactly what the model wrote.
  let rawRemoved = false;
  const webIds = []; const webQueries = [];   // this reply's web searches (websearch.js log)
  const unraw = (x) => { const t = x.replace(RAW_CALL_BLOCK, ''); if (t !== x) rawRemoved = true; return t; };
  let body;
  let choice;
  // Think harder: the picked try is the reply (no tools: the tries are plain replies). If it can't run, the model
  // answers normally and the reply says why.
  let thRun = null;
  if (th) {
    thRun = await runThinkHarder(convId, messages, history, { repair });
    if (thRun.ok) { choice = thRun.choice || {}; body = { choices: [choice], usage: null, model: null }; }
  }
  const picked = Boolean(thRun && thRun.ok);
  // Tool loop: the model may call a tool; we decide by trust level, run it if allowed, hand it the
  // result and ask again, up to MAX_CALLS runs. Every attempt is logged, refused ones too.
  const ranCodes = new Set();
  const hidden = [];          // past-chat search results the model was shown: logged as ids only
  const recalledUser = [];    // the user's side of those results, for the number and source checks (never logged)
  const fetchedTexts = [];    // pages the model read in this reply, for the same checks (never logged)
  const recallRefs = [];
  // Only tool uses that ran count toward the limit (a refused duplicate must not use one up). All attempts are
  // capped at MAX_ATTEMPTS, so the model can't loop on refusals, and two early refusals don't end tool use
  // before anything ran.
  const MAX_ATTEMPTS = tools.MAX_CALLS + 2;
  let ranCount = 0; let refusedCount = 0; let toldStop = false;
  for (let step = 0; !picked; step++) {
    const lastTry = toldStop;
    const toolNames = toolLog.map((t) => t.name);
    body = await callModel(convId, messages, info, { withTools: withTools && !lastTry, memBlock, habBlock, hidden,
      onDelta: (d) => { liveReplies.set(convId, liveView(thinkingParts, d, toolNames)); } });
    choice = (body.choices && body.choices[0]) || {};
    const msg = choice.message || {};
    const call = lastTry || !withTools ? null : tools.findCall(msg);
    if (!call) break;
    if (msg.reasoning) thinkingParts.push(unraw(msg.reasoning).trim());
    let outcome;
    const code = String((call.args && call.args.code) || '');
    if (ranCount >= tools.MAX_CALLS) {
      // Out of tool uses: tell the model so, then ask once more with no tools offered, so the
      // reply ends in an answer instead of "let me try again".
      outcome = { decision: 'refused: tool limit reached', output: toolLimitText(), ok: false };
      toldStop = true;
    } else if (ranCount + refusedCount >= MAX_ATTEMPTS) {
      // Too many attempts in one reply: stop offering tools. The limit message would say the tool had been
      // used three times, and "not available" would say it is off; neither is so here.
      outcome = { decision: 'refused: too many refused calls', output: 'No more tools in this reply; answer with what you have, and say plainly what you could not check.', ok: false };
      toldStop = true;
    } else if (code && ranCodes.has(code)) {
      // Same code again gives the same result; a model can run identical failing code over and over.
      outcome = { decision: 'refused: same code as before', output:
        'That is exactly the code you already ran, so it would give the same result. Change it, or answer without the tool.', ok: false };
    } else {
      if (code) ranCodes.add(code);
      outcome = await tools.handleCall(call, { convId });
    }
    if (/^ran/.test(outcome.decision || '')) ranCount += 1; else if (!toldStop) refusedCount += 1;
    // A note offer's text is kept only in the open approval until the user decides (memory.js rule 1).
    // A held-back search keeps neither the search words nor the matched words, here or in the search log.
    const heldBack = Boolean((outcome.web && outcome.web.blocked) || (outcome.fetch && outcome.fetch.blocked) || (outcome.ask && outcome.ask.blocked));
    const loggedArgs = call.name === 'remember' ? { offer: outcome.approval_id || null }
      : heldBack && outcome.fetch ? { url_sha: lib.sha256(outcome.fetch.url) }
        : heldBack && outcome.ask ? { question_sha: lib.sha256(outcome.ask.question) }
        : heldBack ? { query_sha: lib.sha256(outcome.web.query) } : call.args;
    // A page the model read: its text goes to the number and source checks (from memory, this reply only); the records
    // keep its address, size and a sha, never the text.
    const fetchedOk = call.name === 'web_fetch' && outcome.fetch && outcome.fetch.ok;
    if (fetchedOk) fetchedTexts.push({ name: `web_fetch (${outcome.fetch.final_url || outcome.fetch.url})`, text: outcome.output });
    // Past-chat search: the text the model was shown stays out of every record; the ids say where it looked.
    const searched = call.name === 'search_chats' && outcome.recall;
    if (searched) { hidden.push(outcome.output); recallRefs.push(...outcome.recall); recalledUser.push(outcome.user_text || ''); }
    let how = null;
    if (call.name === 'web_search' && outcome.web) {
      how = { call: !call.raw ? 'a tool call' : (msg.content || '').includes('<tool_call>') ? 'written into the answer text' : 'written into the thinking',
        nth: webIds.length + 1, before: webQueries.slice(), thinking_before: msg.reasoning ? unraw(msg.reasoning).trim().slice(-800) : '' };
    }
    const webId = logWeb(convId, call, outcome, { how });
    if (webId) { webIds.push(webId); webQueries.push(outcome.web.blocked ? '[held back]' : outcome.web.query); }
    const entry = { name: call.name, args: loggedArgs, raw_call: call.raw, in_thinking: call.raw && !(msg.content || '').includes('<tool_call>'),
      trust: outcome.trust || null, decision: outcome.decision,
      output: searched ? `[${outcome.recall.length} past exchanges: ids in recall]` : heldBack ? '[search held back: words not kept]'
        : fetchedOk ? `[page text: ${outcome.output.length} characters, sha ${outcome.fetch.sha.slice(0, 12)}]` : outcome.output,
      ok: outcome.ok, seconds: outcome.seconds || 0,
      ...(searched ? { recall: outcome.recall } : {}) };
    if (outcome.approval_id) entry.approval_id = outcome.approval_id;
    if (webId) entry.web_search_id = webId;
    // Why a search that was sent failed, for the page.
    if (outcome.web && !outcome.web.blocked && !outcome.web.ok) entry.web_error = outcome.web.error || 'failed';
    if (outcome.fetch && !outcome.fetch.blocked) { entry.fetch = { url: outcome.fetch.final_url || outcome.fetch.url, ok: outcome.fetch.ok,
      ...(outcome.fetch.ok ? { bytes: outcome.fetch.bytes, truncated: outcome.fetch.truncated } : { error: outcome.fetch.error }) }; }
    toolLog.push(entry);
    logEvent(convId, { type: 'tool_attempt', ...entry, step });
    const before = (msg.content || '').replace(RAW_CALL_BLOCK, '').trim();
    messages.push({ role: 'assistant', content: before,
      tool_calls: [{ id: `call_${step}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
    messages.push({ role: 'tool', tool_call_id: `call_${step}`, content: outcome.output });
  }
  // A blank reply: asked with no tools offered, a model can still end in a tool call and say nothing. Hand that call
  // the refusal it already knows (the limit message, or "not available"), then ask once more with no tools. Still
  // blank: saved as blank and marked, and the page says so (page text only; a blank reply never goes back into the context).
  let blankAfterRetry = false;
  if (!picked && blankReply(choice)) {
    const msg = choice.message || {};
    if (msg.reasoning) thinkingParts.push(unraw(msg.reasoning).trim());
    const call = tools.findCall(msg);
    const overLimit = ranCount >= tools.MAX_CALLS;
    logEvent(convId, { type: 'harness', event: 'blank reply, asked once more',
      detail: `finish_reason ${choice.finish_reason || 'none'}${call ? `, the model asked for ${call.name} with no tools offered` : ''}` });
    if (call) {
      const entry = { name: call.name, args: call.name === 'remember' ? { offer: null } : call.args, raw_call: call.raw,
        in_thinking: call.raw && !(msg.content || '').includes('<tool_call>'), trust: null,
        decision: overLimit ? 'refused: tool limit reached' : 'refused: no tools offered',
        output: overLimit ? toolLimitText() : `${call.name} is not available to you.`, ok: false, seconds: 0 };
      toolLog.push(entry);
      logEvent(convId, { type: 'tool_attempt', ...entry, step: 'retry' });
      messages.push({ role: 'assistant', content: (msg.content || '').replace(RAW_CALL_BLOCK, '').trim(),
        tool_calls: [{ id: 'call_retry', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] });
      messages.push({ role: 'tool', tool_call_id: 'call_retry', content: entry.output });
    }
    const toolNames = toolLog.map((t) => t.name);
    body = await callModel(convId, messages, info, { withTools: false, memBlock, habBlock, hidden,
      onDelta: (d) => { liveReplies.set(convId, liveView(thinkingParts, d, toolNames)); } });
    choice = (body.choices && body.choices[0]) || {};
    blankAfterRetry = blankReply(choice);
  }
  // Show what the model said, without any leftover raw tool-call markup.
  if (choice.message && choice.message.content) choice.message.content = unraw(choice.message.content);
  // Also in the thinking: a raw call there would otherwise show as "answered in its thinking".
  if (choice.message && choice.message.reasoning) choice.message.reasoning = unraw(choice.message.reasoning);
  const reply = lib.splitReply(choice);
  if (thinkingParts.length) reply.thinking = [...thinkingParts, reply.thinking].filter(Boolean).join('\n\n— (after tool) —\n\n');
  const seconds = (Date.now() - t0) / 1000;
  const move = toolLog.length
    ? `reached for ${toolLog[0].name} first (${toolLog[0].decision}), then ${lib.firstMove(reply)}`
    : lib.firstMove(reply);
  const check = lib.checkFlags(reply.text);
  // Arithmetic the model wrote that does not work out. A plain rule check, shown on the reply and kept on its
  // record in every chat. The reply is never changed.
  const slips = lib.arithmeticSlips(reply.text, [...history.filter((x) => x.author !== 'model').map((x) => x.text),
    ...toolLog.map((x) => (typeof x.output === 'string' ? x.output : '')), ...recalledUser]);   // a quoted sum is marked, still shown
  // The number check: each phone number the model gave, found or not in what it saw while writing this reply
  // (its tool results, past-chat results, the user's reference card and the user's own messages). Page and records
  // only; the reply is never changed.
  const numbers = check.flags.filter((f) => f.type === 'number').map((f) => f.match);
  const sawSources = [
    ...toolLog.filter((t) => typeof t.output === 'string' && !t.output.startsWith('[search held back')).map((t) => ({ name: t.name, text: t.output, ok: t.ok })),
    // Past-chat results: the user's side only, so a number or source the model made up earlier and then found again
    // in a past chat doesn't count.
    ...recalledUser.map((text) => ({ name: 'you said it in a past chat', text })),
    ...fetchedTexts,
    { name: 'your emergency card', text: emergencyCard() || '' },
    { name: 'you gave it', text: history.filter((m) => m.author === 'user').map((m) => m.text).join('\n') },
    { name: 'an approved tool run', text: history.filter((m) => m.author === 'tool').map((m) => m.text).join('\n') },
    // The teacher's answer is something the model saw, like the user's own messages.
    { name: 'the teacher said it', text: history.filter((m) => m.author === 'teacher').map((m) => m.text).join('\n') },
  ];
  const numberCheck = numbers.length ? lib.sourceNumbers(numbers, sawSources) : null;
  // The invented-source check: each source the model names ("X confirms", "according to X", "from official sources"),
  // found or not in the same things it saw.
  const claimed = lib.sourceClaims(reply.text);
  const sourceCheck = claimed.length ? lib.checkSources(claimed, sawSources) : null;
  // Medical or crisis if either the reply or the question it was answering is.
  const sensitive = check.sensitive || lib.checkFlags(asked ? asked.text : '').sensitive;
  const contextTokens = (body.usage && body.usage.prompt_tokens) || null;
  const skipFacts = toolLog.length || picked ? [] : lib.skipFacts(reply, { history, systemPrompt: sys, messages, contextTokens });
  // "Remembered: …": the notes in the model's context, and the ones its words probably drew on (shared words: a
  // guess, and the page says so). Ids only.
  const habitIds = habBlock ? habBlock.ids : [];
  const memFacts = memBlock ? { live: true, note_ids: memBlock.note_ids, sha: memBlock.sha, omitted: memBlock.omitted,
    likely: memory.likelyUsed(`${reply.text}\n${reply.thinking || ''}`, memBlock.note_ids), habit_ids: habitIds }
    : memLive ? { live: true, note_ids: [], likely: [], habit_ids: habitIds } : null;
  const facts = {
    ...(blankAfterRetry ? { blank_after_retry: true } : {}),
    ...(rawRemoved ? { raw_call_removed: true } : {}),
    ...(reply.strayThinkTags ? { stray_think_tags: reply.strayThinkTags } : {}),
    ...(numberCheck ? { numbers_found: numberCheck.found, numbers_unsourced: numberCheck.unsourced } : {}),
    ...(slips.length ? { arithmetic_slips: slips } : {}),
    ...(sourceCheck ? { sources_found: sourceCheck.found, sources_unsourced: sourceCheck.unsourced } : {}),
    ...(thRun ? { think_harder: thinkHarderFacts(thRun, repair) } : {}),
    ...(memFacts ? { memory: memFacts } : {}),
    ...(recallRefs.length ? { recall: recallRefs } : {}),
  };
  logEvent(convId, {
    skip_facts: skipFacts,
    type: 'reply', thinking: reply.thinking, text: reply.text, finished: reply.finished,
    finish_reason: reply.finishReason, first_move: move, seconds, usage: body.usage || null,
    model_served: body.model || null, answer_in_thinking: reply.answerInThinking,
    check_flags: check.flags, sensitive, context_tokens: contextTokens, tools: toolLog,
    ...facts,
  });
  const saved = addMessage(convId, 'model', reply.text, {
    thinking: reply.answerInThinking ? '' : reply.thinking, answer_in_thinking: reply.answerInThinking,
    check_flags: check.flags, sensitive, context_tokens: contextTokens, tools: toolLog,
    finished: reply.finished, first_move: move, skip_facts: skipFacts,
    ...facts,
    model: { ...info, served: body.model || null }, sampling: SAMPLING,
  });
  // Arithmetic the model stated that does not work out becomes a miss for the review (only when review is switched on,
  // and only for a question you asked yourself).
  if (review.status().switched_on && asked && asked.author === 'user') {
    for (const a of slips.filter((x) => !x.quoted)) {
      const rec = misses.logMiss({ convId, questionId: asked.id, replyId: saved.id, prompt: asked.text, reply: reply.text,
        check: { kind: 'rule:arithmetic', detail: a.expr, claimed: a.claimed, expected: a.actual } });
      if (rec) logEvent(convId, { type: 'harness', event: 'miss logged', detail: `${a.expr} = ${a.actual}, the model said ${a.claimed}` });
    }
  }
  websearch.noteOutcome(webIds, reply.text);   // which result links the answer named
  return saved;
}

// ---- The review ----
// One run at a time. Each of the model's review replies waits its turn behind chat replies (serial), so a chat is never
// blocked for the whole run.
let reviewError = null;
async function reviewCall(messages) {
  const res = await fetch(`${MODEL_URL}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(MODEL_NAME ? { model: MODEL_NAME } : {}), messages, max_tokens: MAX_TOKENS, ...SAMPLING, stream: false }),
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`model server answered ${res.status}`);
  // A fixed message if the body isn't JSON, so none of the server's text reaches the run log.
  let body;
  try { body = await res.json(); } catch { throw new Error('the model server sent a reply that was not JSON'); }
  return (body.choices && body.choices[0]) || {};
}
function startReview() {
  reviewError = null;
  review.run({ call: (messages) => serial(() => reviewCall(messages)),
    convExists: (id) => validConvId(id) && fs.existsSync(convFile(id)), info: modelInfo() })
    .catch((err) => { reviewError = failReason(err) === 'something went wrong' ? String(err.message || err) : failReason(err); });
}

// ---- HTTP ----

function send(res, status, obj, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(obj) : obj;
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', connection: 'close' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const chatTitle = (id) => {
  const first = lib.readJsonl(convFile(id)).find((x) => x.author !== 'model' && (x.text || '').trim());
  return first ? first.text.trim().replace(/\s+/g, ' ').slice(0, 48) : 'a chat';
};

// Ask for a reply, and answer the HTTP request with it, or with the reason it failed (the message stays saved).
async function replyTo(res, convId, extra, withTools = true) {
  try {
    const reply = await serial(() => askModel(convId, { withTools }));
    return send(res, 200, { ...extra, reply });
  } catch (err) {
    logEvent(convId, { type: 'harness', event: 'reply failed', detail: String((err && err.message) || err) });
    return send(res, 200, { ...extra, failed: replyFailed.get(convId) || { reason: 'something went wrong' } });
  }
}

function makeServer(token, { allowedHosts = bind.allowedHostHeaders({ loopback: true }, PORT) } = {}) {
  return http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only our own host names.
      if (!allowedHosts.has(req.headers.host)) return send(res, 403, { error: 'bad host' });
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'), 'text/html; charset=utf-8');
      }
      // Everything else needs the token.
      const given = req.headers['x-lh-token'] || url.searchParams.get('t') || '';
      const ok = given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
      if (!ok) return send(res, 401, { error: 'token required' });

      if (req.method === 'GET' && url.pathname === '/api/info') {
        const active = await pingModel();
        const levels = tools.trustLevels();
        return send(res, 200, { model: modelInfo(), model_url: MODEL_URL, model_up: active.up,
          system_prompt: Boolean(systemPrompt().trim()), memory: memory.status(), review: review.status(), long_context_tokens: lib.LONG_CONTEXT_TOKENS,
          think_harder: { on: trust.level('think_harder') !== 'off', repair: trust.level('think_harder_repair') !== 'off' },
          teacher: { name: lib.AUTHORS.teacher.label, endpoint: teacher.configured() },
          tools: Object.keys(tools.TOOLS).map((name) => ({ name, trust: levels[name] })),
          // The user's own reference card, shown on medical/crisis replies. Empty unless the user writes emergency_card.txt
          // with numbers they have verified themselves.
          emergency_card: emergencyCard() });
      }
      if (req.method === 'GET' && url.pathname === '/api/conversations') {
        fs.mkdirSync(CONV_DIR, { recursive: true });
        const ids = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort().reverse();
        // Titles for the sidebar: the user's own title, or the first thing said, shortened.
        const meta = chatMeta();
        const items = ids.map((id) => {
          const msgs = lib.readJsonl(convFile(id));
          const first = msgs.find((x) => x.author !== 'model' && (x.text || '').trim());
          const m = meta[id] || {};
          const title = m.title || (first ? first.text.trim().replace(/\s+/g, ' ').slice(0, 48) : 'New chat');
          const unverified = msgs.filter((x) => x.author === 'model').reduce((n, x) => n + lib.checkFlags(x.text).flags.length, 0);
          return { id, title, renamed: Boolean(m.title), pinned: Boolean(m.pinned), archived: Boolean(m.archived),
            messages: msgs.length, unverified, updated: fs.statSync(convFile(id)).mtimeMs };
        }).sort((a, b) => b.updated - a.updated);
        return send(res, 200, { conversations: ids, items });
      }
      // Approvals: tool calls waiting for the user's yes or no.
      if (req.method === 'POST' && url.pathname === '/api/approval') {
        const b = await readBody(req);
        if (!['approve', 'reject'].includes(b.decision)) return send(res, 400, { error: 'decision must be approve or reject' });
        // A note offer is saved BEFORE it is closed: if saving fails (say the note is over 300 characters) the offer stays
        // open, so the user can shorten the text and approve again, and nothing is left half done.
        if (b.decision === 'approve') {
          const open = approvals.getOpenApproval(b.id);
          if (open && open.name === 'remember') {
            const text = b.args && typeof b.args.text === 'string' ? b.args.text : open.args.text;
            const source = (b.args && b.args.source) || open.args.source;
            let note;
            try {
              note = memory.add({ text, source: source === 'noticed' ? 'noticed' : 'told', convId: open.conv_id, offerId: open.id,
                by: text !== open.args.text ? 'user' : 'model' });
            } catch (e) {
              // Memory's errors are fixed phrases (never the text), so the reason can be logged.
              logEvent(open.conv_id, { type: 'memory_write', event: 'note not saved, offer left open', offer: open.id, detail: String(e.message || e) });
              return send(res, 400, { error: `${String(e.message || e)}. The offer is still open: change the words and approve again, or decline it.` });
            }
            const apr = approvals.closeApproval(b.id, 'approved');
            approvals.setApprovalArgs(open.id, { note_id: note.id });
            logEvent(open.conv_id, { type: 'memory_write', event: 'note saved', note_id: note.id, offer: open.id, final_text_by: note.final_text_by });
            return send(res, 200, { approval: { ...(apr || open), args: { note_id: note.id } }, note });
          }
        }
        const apr = approvals.closeApproval(b.id, b.decision === 'approve' ? 'approved' : 'rejected');
        if (!apr) return send(res, 404, { error: 'no such open request' });
        // A read-only tool never runs through an approval.
        if (tools.TOOLS[apr.name] && tools.TOOLS[apr.name].noApproval) return send(res, 400, { error: `${apr.name} never runs through an approval` });
        if (apr.name === 'remember') {
          // A note offer is saved only on a yes, and the offer's text is then dropped from the approval record (the
          // note itself, if saved, is the only copy). No new reply is asked for. Approving is handled above; only a
          // decline reaches here.
          if (b.decision === 'reject') {
            approvals.setApprovalArgs(apr.id, {});
            logEvent(apr.conv_id, { type: 'memory_write', event: 'offer declined', offer: apr.id });
            return send(res, 200, { approval: { ...apr, args: {} } });
          }
          return send(res, 500, { error: 'a note offer is approved before it is closed' });
        }
        if (b.decision === 'reject') {
          logEvent(apr.conv_id, { type: 'harness', event: 'user rejected a tool request', detail: apr.name });
          return send(res, 200, { approval: apr });
        }
        // Approved as written, or approved after the user edited it.
        if (apr.name === 'ask_someone') {
          // The exact question you saw is the one sent (an edit is ignored). The guard runs once more before anything leaves.
          const g = await tools.runApproved('ask_someone', apr.args, { convId: apr.conv_id });
          if (g.blocked) {
            logEvent(apr.conv_id, { type: 'harness', event: 'question held back by the guard', detail: `question_sha ${lib.sha256(String(apr.args.question || ''))}` });
            approvals.setApprovalArgs(apr.id, { question_sha: lib.sha256(String(apr.args.question || '')) });
            return send(res, 200, { approval: { ...apr, args: {} }, held_back: true });
          }
          const ask = asks.addAsk({ convId: apr.conv_id, question: g.ask.question, approvalId: apr.id });
          logEvent(apr.conv_id, { type: 'harness', event: 'question approved', detail: `ask ${ask.id}, question_sha ${lib.sha256(ask.question)}` });
          if (!teacher.configured()) return send(res, 200, { approval: apr, ask });
          // With an endpoint set, the question text leaves this computer for that URL.
          const t = await teacher.ask(ask.question);
          if (!t.ok) {
            logEvent(apr.conv_id, { type: 'harness', event: 'teacher endpoint failed', detail: t.error });
            return send(res, 200, { approval: apr, ask, teacher_error: t.error });
          }
          asks.closeAsk(ask.id, 'endpoint');
          addMessage(apr.conv_id, 'teacher', t.text, { ask_id: ask.id });
          return replyTo(res, apr.conv_id, { approval: apr, ask: { ...ask, status: 'answered' } });
        }
        const edited = Boolean(b.args && JSON.stringify(b.args) !== JSON.stringify(apr.args));
        const args = edited ? b.args : apr.args;
        const result = await tools.runApproved(apr.name, args, { convId: apr.conv_id });
        const call = { name: apr.name, args };
        const webId = logWeb(apr.conv_id, call, result, { how: { call: 'a tool call, approved by the user', nth: 1, before: [], thinking_before: '' } });
        logEvent(apr.conv_id, { type: 'tool_attempt', name: apr.name, args: result.blocked ? { redacted: true } : args, trust: 'ask',
          decision: edited ? 'ran after user edit' : 'ran after user approval', output: result.output, ok: result.ok, step: 0,
          ...(webId ? { web_search_id: webId } : {}) });
        const text = `${apr.name}${args && args.code ? `\n${args.code}` : ''}\n→ ${result.output}`;
        addMessage(apr.conv_id, 'tool', text, { approval_id: apr.id });
        return replyTo(res, apr.conv_id, { approval: apr, edited });
      }
      // The chat menu: rename (empty puts the first words back), pin, archive. Page settings only.
      if (req.method === 'POST' && url.pathname === '/api/chat/meta') {
        const b = await readBody(req);
        if (!validConvId(b.conv_id) || !fs.existsSync(convFile(b.conv_id))) return send(res, 404, { error: 'no such conversation' });
        const change = {};
        if ('title' in b) {
          if (b.title != null && typeof b.title !== 'string') return send(res, 400, { error: 'title must be text' });
          change.title = b.title == null ? null : b.title.trim().replace(/\s+/g, ' ').slice(0, 80);
        }
        if ('pinned' in b) change.pinned = Boolean(b.pinned);
        if ('archived' in b) { change.archived = Boolean(b.archived); if (change.archived) change.pinned = false; }
        const meta = setChatMeta(b.conv_id, change);
        return send(res, 200, { conv_id: b.conv_id, meta });
      }
      // Forget a chat everywhere the harness keeps it.
      if (req.method === 'POST' && url.pathname === '/api/forget') {
        const b = await readBody(req);
        if (!validConvId(b.conv_id) || !fs.existsSync(convFile(b.conv_id))) return send(res, 404, { error: 'no such conversation' });
        const removed = { approvals: approvals.forgetConv(b.conv_id), asks: asks.forgetConv(b.conv_id), misses: misses.deleteMisses({ convId: b.conv_id }) };
        websearch.forget(b.conv_id);   // searches from this chat leave the search log too
        webfetch.forget(b.conv_id);    // and the pages read
        setChatMeta(b.conv_id, { title: null, pinned: false, archived: false });   // and its title, pin and archive mark
        for (const file of [convFile(b.conv_id), logFile(b.conv_id), logMdFile(b.conv_id)]) { try { fs.unlinkSync(file); } catch {} }
        // Its review cases are deleted; a habit kept from it loses its links to the chat. Notes and habits that came from this
        // chat stay until you delete them: the page asks.
        const habitsFromChat = review.prune((id) => validConvId(id) && fs.existsSync(convFile(id)));
        return send(res, 200, { forgotten: b.conv_id, removed, notes_from_chat: memory.fromChat(b.conv_id), habits_from_chat: habitsFromChat });
      }
      // The Memory page: the user sees, adds, edits and really deletes notes.
      if (req.method === 'GET' && url.pathname === '/api/memory') return send(res, 200, { status: memory.status(), notes: memory.list() });
      if (req.method === 'POST' && url.pathname === '/api/memory/add') {
        const b = await readBody(req);
        try { return send(res, 200, { note: memory.add({ text: b.text, source: 'wrote', by: 'user' }) }); }
        catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/edit') {
        const b = await readBody(req);
        try { const n = memory.edit(b.id, b.text); return n ? send(res, 200, { note: n }) : send(res, 404, { error: 'no such note' }); }
        catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/delete') {
        const b = await readBody(req);
        return memory.remove(b.id) ? send(res, 200, { deleted: b.id }) : send(res, 404, { error: 'no such note' });
      }
      // Mark a reply wrong and give the right answer: a miss for the review. The correct answer is used only to check the model later.
      if (req.method === 'POST' && url.pathname === '/api/miss') {
        const b = await readBody(req);
        if (!review.status().switched_on) return send(res, 400, { error: 'the review is off ("review": "on" in trust.json turns it on)' });
        if (!validConvId(b.conv_id) || !fs.existsSync(convFile(b.conv_id))) return send(res, 404, { error: 'no such conversation' });
        if (typeof b.expected !== 'string' || !b.expected.trim()) return send(res, 400, { error: 'give the right answer' });
        const msgs = lib.readJsonl(convFile(b.conv_id));
        const i = msgs.findIndex((x) => x.id === b.message_id && x.author === 'model');
        if (i < 0) return send(res, 404, { error: 'no such reply' });
        const q = msgs.slice(0, i).reverse().find((x) => x.author === 'user');
        if (!q) return send(res, 400, { error: 'only replies to your own questions can be logged' });
        const rec = misses.logMiss({ convId: b.conv_id, questionId: q.id, replyId: msgs[i].id, prompt: q.text, reply: msgs[i].text,
          check: { kind: 'user', detail: 'marked by you', expected: b.expected.trim() } });
        if (rec) logEvent(b.conv_id, { type: 'harness', event: 'miss logged', detail: 'marked by you' });
        return send(res, 200, { miss: rec, already: !rec });
      }
      // Review: the model proposes habits, you decide.
      if (req.method === 'GET' && url.pathname === '/api/review') {
        const cases = review.list();
        return send(res, 200, { status: review.status(), progress: review.progress(), error: reviewError, cases,
          chats: Object.fromEntries([...new Set(cases.map((c) => c.conv_id).filter(Boolean))]
            .filter((id) => validConvId(id) && fs.existsSync(convFile(id))).map((id) => [id, chatTitle(id)])) });
      }
      if (req.method === 'POST' && url.pathname === '/api/review/run') {
        if (!review.live()) return send(res, 400, { error: `the review is off: ${review.status().why_off}` });
        if (review.running()) return send(res, 200, { already: true });
        if (!(await pingModel()).up) return send(res, 400, { error: `the model server is not answering at ${MODEL_URL}, so there is nothing to ask. Start it and press Review again.` });
        startReview();
        return send(res, 200, { started: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/review/decide') {
        const b = await readBody(req);
        try { const c = review.decide(b.id, b.decision, { kind: b.kind, habit: b.habit }); return c ? send(res, 200, { case: c }) : send(res, 404, { error: 'no such case waiting' }); }
        catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/review/edit') {
        const b = await readBody(req);
        try { const c = review.edit(b.id, { kind: b.kind, habit: b.habit }); return c ? send(res, 200, { case: c }) : send(res, 404, { error: 'no such habit' }); }
        catch (e) { return send(res, 400, { error: String(e.message || e) }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/review/delete') {
        const b = await readBody(req);
        return review.remove(b.id) ? send(res, 200, { deleted: b.id }) : send(res, 404, { error: 'no such habit' });
      }
      // ask_someone: open questions, and an answer from a person or program (node src/cli.js answer).
      if (req.method === 'GET' && url.pathname === '/api/asks') return send(res, 200, { asks: asks.listAsks(url.searchParams.get('open') === '1') });
      if (req.method === 'POST' && url.pathname === '/api/ask/answer') {
        const b = await readBody(req);
        if (typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: 'empty answer' });
        const open = asks.listAsks(true).find((x) => x.id === b.id);
        if (!open || !validConvId(open.conv_id) || !fs.existsSync(convFile(open.conv_id))) return send(res, 404, { error: 'no such open question' });
        const ask = asks.closeAsk(b.id, 'cli');
        const msg = addMessage(ask.conv_id, 'teacher', b.text.trim(), { ask_id: ask.id });
        return replyTo(res, ask.conv_id, { sent: msg });
      }
      if (req.method === 'POST' && url.pathname === '/api/new') {
        const id = lib.newId('c');
        fs.mkdirSync(CONV_DIR, { recursive: true });
        fs.writeFileSync(convFile(id), '');
        logEvent(id, { type: 'harness', event: 'conversation started' });
        return send(res, 200, { conv_id: id });
      }
      const m = url.pathname.match(/^\/api\/conv\/([^/]+)(\/log|\/live)?$/);
      if (req.method === 'GET' && m) {
        if (!validConvId(m[1]) || !fs.existsSync(convFile(m[1]))) return send(res, 404, { error: 'no such conversation' });
        // The model's reply while it writes it: polled by the page, so kept light.
        if (m[2] === '/live') return send(res, 200, { live: liveReplies.get(m[1]) || null });
        if (m[2]) return send(res, 200, fs.existsSync(logMdFile(m[1])) ? fs.readFileSync(logMdFile(m[1]), 'utf8') : '', 'text/markdown; charset=utf-8');
        // Flags are recomputed on the way out (never written back), so older replies and stricter rules apply
        // everywhere; the question counts toward "sensitive" too.
        const raw = lib.readJsonl(convFile(m[1]));
        const messages = raw.map((msg, i) => {
          if (msg.author !== 'model') return msg;
          const c = lib.checkFlags(msg.text);
          const q = raw.slice(0, i).reverse().find((x) => x.author !== 'model');
          const people = raw.slice(0, i).filter((x) => x.author === 'user' || x.author === 'tool').map((x) => x.text);
          const marks = lib.markReply(msg.text, msg.tools || [], people, systemPrompt());
          return { ...msg, check_flags: c.flags, sensitive: c.sensitive || lib.checkFlags(q ? q.text : '').sensitive,
            marks: marks.sentences, stated_confidence: marks.stated_confidence };
        });
        return send(res, 200, { conv_id: m[1], messages,
          writing: liveReplies.has(m[1]), failed: replyFailed.get(m[1]) || null,
          approvals: approvals.listApprovals(m[1]), asks: asks.listAsks(true).filter((x) => x.conv_id === m[1]),
          think_harder: thinkProgress.get(m[1]) || (thinking.has(m[1]) ? { stage: 'queued', done: 0, total: thinkharder.TRIES + 1 } : null),
          // The habits the replies here had in context (a forgotten habit is simply missing).
          habits: Object.fromEntries([...new Set(messages.flatMap((x) => (x.memory && x.memory.habit_ids) || []))]
            .map((id) => [id, review.get(id)]).filter(([, h]) => h && h.status === 'kept').map(([id, h]) => [id, { kind: h.kind, habit: h.habit }])),
          // The notes the replies here had in context (a deleted note shows as forgotten on the page).
          notes: Object.fromEntries([...new Set(messages.flatMap((x) => (x.memory && x.memory.note_ids) || []))]
            .map((id) => [id, memory.get(id)]).filter(([, n]) => n)),
          // The chats the replies here looked back at, by title (a forgotten chat is simply missing).
          recall_chats: Object.fromEntries([...new Set(messages.flatMap((x) => (x.recall || []).map((r) => r.conv_id)))]
            .filter((id) => validConvId(id) && fs.existsSync(convFile(id))).map((id) => [id, chatTitle(id)])) });
      }
      if (req.method === 'POST' && url.pathname === '/api/send') {
        const b = await readBody(req);
        if (!validConvId(b.conv_id) || !fs.existsSync(convFile(b.conv_id))) return send(res, 404, { error: 'no such conversation' });
        if (typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: 'empty message' });
        // Pasted text is tagged by the page: it is the sender's message, but not their words.
        const pasted = Array.isArray(b.pasted) ? b.pasted.filter((p) => typeof p === 'string' && p.trim() && b.text.includes(p)).slice(0, 20) : [];
        const msg = addMessage(b.conv_id, 'user', b.text.trim(), pasted.length ? { pasted } : undefined);
        replyFailed.delete(b.conv_id);
        if (b.reply === false) return send(res, 200, { sent: msg });
        // "Chat" mode in the page sends tools: false, so no tools are offered for this reply.
        const withTools = b.tools !== false;
        if (b.think_harder === true) {
          // Think harder takes about nine replies' worth of time: answer the request now and deliver the reply through the
          // page's refresh, so a dropped request never starts a second run.
          if (trust.level('think_harder') === 'off') return send(res, 400, { error: 'think harder is off ("think_harder": "on" in trust.json turns it on)', sent: msg });
          const repair = b.repair === true && trust.level('think_harder_repair') !== 'off';
          thinking.add(b.conv_id);
          serial(() => askModel(b.conv_id, { withTools, thinkHarder: true, repair }))
            .catch((err) => logEvent(b.conv_id, { type: 'harness', event: 'think harder failed', detail: String((err && err.message) || err) }));
          return send(res, 200, { sent: msg, think_harder: { started: true, repair } });
        }
        return replyTo(res, b.conv_id, { sent: msg }, withTools);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: String(err.message || err) });
    }
  });
}

async function check() {
  const r = await pingModel();
  console.log(r.up ? `model server answers at ${MODEL_URL}${r.id ? ` (model: ${r.id})` : ''}` : `no answer from ${MODEL_URL}/v1/models`);
  process.exitCode = r.up ? 0 : 1;
}

function main() {
  if (process.argv.includes('--check')) { check(); return; }
  fs.mkdirSync(DATA, { recursive: true });
  // Keep the token across restarts so the link keeps working; delete the file to get a fresh one.
  let token = '';
  try { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
  if (!/^[0-9a-f]{48}$/.test(token)) {
    token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  }
  let where;
  try { where = bind.resolveBind(process.env); } catch (err) { console.error(`not started: ${err.message}`); process.exitCode = 1; return; }
  let extraHosts; try { extraHosts = bind.extraHostHeaders(); } catch (err) { console.error(`not started: ${err.message}`); process.exitCode = 1; return; }
  const server = makeServer(token, { allowedHosts: bind.allowedHostHeaders(where, PORT, undefined, extraHosts) });
  server.on('error', (err) => {
    const hint = err.code === 'EADDRNOTAVAIL' ? ` ${where.host} is not an address of this computer right now.`
      : err.code === 'EADDRINUSE' ? ` Port ${PORT} is already in use (set LH_PORT to use another).` : '';
    console.error(`not started: ${err.message}.${hint}`); process.exitCode = 1;
  });
  server.listen(PORT, where.host, () => {
    if (where.warning) console.warn(`\n  WARNING: ${where.warning}\n`);
    const [local, ...others] = bind.pairingUrls(where, PORT, token);
    console.log(`local-harness on ${local}`);
    for (const u of others) console.log(`also on: ${u}`);
    console.log(`transcripts and logs: ${DATA}`);
    console.log(`model server: ${MODEL_URL}`);
    pingModel().then((r) => { if (!r.up) console.warn(`  note: no answer from ${MODEL_URL}/v1/models yet. Start your model server, or set LH_MODEL_URL.`); });
  });
}

if (require.main === module) main();

module.exports = { makeServer };

// Pure helpers for the harness: no I/O here except the small file helpers at the bottom,
// so the logic can be tested without a model or a server.
//
// Every message is tagged with who wrote it: the user, the model, or a tool result.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const AUTHORS = {
  user: { source: 'user', label: null },
  // The result of a tool run the user approved after the model's reply. Machine text.
  tool: { source: 'tool', label: 'Tool result' },
  model: { source: 'model', label: null },
};

// The thinking caveat shown at the top of every readable log.
const THINKING_CAVEAT =
  'The model\'s thinking is the text it wrote before answering. It is not a guaranteed window '
  + 'into why it answered: a model can write a convincing reason after the fact. This log '
  + 'shows what it wrote and what it did.';

function newId(prefix = 'c') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  return `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Build the message list for the model. Prior replies carry only their final text (the
// thinking stays in the log, not in the context). Consecutive user and tool turns are merged
// into one user turn. Pasted text is marked as such, so the model can tell the sender's own
// words from what they pasted.
function tagPasted(text, pasted) {
  let out = text || '';
  for (const p of pasted || []) if (out.includes(p)) out = out.replace(p, `[pasted text]\n${p}\n[end of pasted text]`);
  return out;
}

function buildModelMessages(messages, systemPrompt = '') {
  const out = [];
  if (systemPrompt && systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of messages) {
    if (m.author === 'model') {
      // Never send an empty reply back into the context: after one or two blank assistant
      // turns a model tends to copy the pattern and stop at once. The user turns around it
      // merge into one user turn instead.
      if ((m.text || '').trim()) out.push({ role: 'assistant', content: m.text });
      continue;
    }
    const label = AUTHORS[m.author] && AUTHORS[m.author].label;
    const line = label ? `${label}: ${tagPasted(m.text, m.pasted)}` : tagPasted(m.text, m.pasted);
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content += `\n\n${line}`;
    else out.push({ role: 'user', content: line });
  }
  return out;
}

// Split a chat-completion choice into thinking, final text and whether the model finished.
// Some servers put reasoning in message.reasoning (or reasoning_content); fall back to <think> tags in content.
function splitReply(choice) {
  const msg = (choice && choice.message) || {};
  let thinking = msg.reasoning || msg.reasoning_content || '';
  let text = msg.content || '';
  let closed = true;
  if (!thinking && text.includes('</think>')) {
    const i = text.indexOf('</think>');
    thinking = text.slice(0, i).replace(/^\s*<think>/, '');
    text = text.slice(i + '</think>'.length);
  } else if (!thinking && /^\s*<think>/.test(text)) {
    // Opened thinking and never closed it: everything is thinking, no answer.
    thinking = text.replace(/^\s*<think>/, '');
    text = '';
    closed = false;
  }
  // A stray tag in the answer ("</think>" shown mid-reply after the reasoning field was already split off):
  // the tag goes, every word the model wrote stays.
  let strayThinkTags = 0;
  text = text.replace(/(`[^`\n]*`)|<\/?think>/g, (m, code) => { if (code) return code; strayThinkTags++; return ''; });
  const cutOff = (choice && choice.finish_reason) === 'length';
  const finished = closed && !cutOff;
  const out = { thinking: thinking.trim(), text: text.trim(), finished, finishReason: (choice && choice.finish_reason) || null,
    answerInThinking: false, ...(strayThinkTags ? { strayThinkTags } : {}) };
  // A chat template may open every reply with <think>. If the model stops without ever closing it, the
  // server files everything as thinking and the visible reply is blank, though the model often
  // wrote its whole answer there. Show that text as the answer, marked, so the chat and the
  // context aren't blank. Not when it was cut off at the token limit.
  if (!out.text && out.thinking && !cutOff) {
    out.text = out.thinking;
    out.answerInThinking = true;
  }
  return out;
}

// What did the model do first on this turn?
function firstMove(reply) {
  if (reply.answerInThinking) return 'answered inside its thinking (never closed it)';
  if (!reply.finished && !reply.text) return 'cut off while thinking (no answer)';
  if (!reply.finished) return 'answered, but was cut off';
  if (!reply.text) return reply.thinking ? 'thought, but gave no answer' : 'gave no answer';
  if (reply.thinking) return 'thought, then answered';
  return 'answered without thinking';
}

// When the model answered without thinking: facts the harness can see about that turn.
// Never a guess at its reasons.
function skipFacts(reply, { history = [], systemPrompt = '', messages = [], contextTokens = null } = {}) {
  if (reply.answerInThinking || reply.thinking || !reply.text) return [];
  const facts = [];
  facts.push(systemPrompt && systemPrompt.trim() ? 'a system prompt was in place' : 'no system prompt in this chat');
  const earlier = messages.filter((m) => m.role === 'assistant' && !m.tool_calls).length;
  if (earlier) facts.push(`${earlier} earlier repl${earlier === 1 ? 'y' : 'ies'} of the model in context, sent without their thinking`);
  const skippedBefore = history.filter((m) => m.author === 'model' && m.first_move === 'answered without thinking').length;
  if (skippedBefore) facts.push(`skipped thinking ${skippedBefore} time${skippedBefore === 1 ? '' : 's'} earlier in this chat`);
  const asked = [...history].reverse().find((m) => m.author !== 'model');
  if (asked) {
    const n = (asked.text || '').length;
    facts.push(`answering ${asked.author === 'tool' ? 'a tool result' : 'the user'} (${n < 40 ? 'a short message' : `${n} characters`})`);
  }
  if (contextTokens) facts.push(`carrying ${contextTokens} tokens`);
  return facts;
}

// "Check this" flags for the reader (never shown to the model, never in its context). Models
// give wrong phone numbers for helplines and invent doses, so specifics like these are marked
// for verification.
const SENSITIVE_WORDS = /\b(overdose|pills?|tablets?|dose|dosage|medication|medicine|prescription|poison\w*|suicid\w*|self[- ]harm|kill myself|crisis|emergency|chest pain|heart attack|stroke|seizure|911|988|ambulance|bleeding|unconscious|allerg\w*|depress\w*|can'?t sleep|symptoms?|feel(?:ing|s)? (?:really |so |very |pretty )?(?:low|down|hopeless|empty|worthless|numb)|hopeless\w*|can'?t go on|(?:hurt|harm|cut)(?:ing)? (?:myself|themsel(?:f|ves)|himself|herself)|want(?:ing)? to die|end (?:it all|my life)|no reason to live|panic attack)\b/i;

// Was a number the model gave in what it actually saw while writing the reply? numbers: the 'number' flags'
// text. sources: [{ name, text }], such as each tool output of the reply, the reference card and the user's own
// messages. A number counts as found when its digits match a run of digits in a source, allowing a country code
// (up to 3 digits) in front of either one. Never shown to the model.
// Every digit group, and every run of up to 5 neighbouring groups on one line, joined: so "321 654 987 159" offers 321,
// 654, 987 and 159 as well as their joins, and "+44 20 7946 0000" offers 442079460000 and 2079460000.
function digitRuns(s) {
  const out = [];
  for (const run of String(s || '').match(/\d[\d \t().\/-]*\d|\d/g) || []) {
    const g = run.split(/\D+/).filter(Boolean);
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j <= Math.min(g.length, i + 5); j++) out.push(g.slice(i, j).join(''));
  }
  return out;
}
function sourceNumbers(numbers, sources) {
  const found = []; const unsourced = [];
  for (const n of numbers) {
    const d = String(n).replace(/\D/g, '');
    if (!d) continue;
    const match = (r) => r === d || (r.endsWith(d) && r.length - d.length <= 3 && d.length >= 3)
      || (d.endsWith(r) && d.length - r.length <= 3 && r.length >= 5);
    const src = sources.find((s) => digitRuns(s.text).some(match));
    if (src) found.push({ number: n, source: src.name }); else unsourced.push(n);
  }
  return { found, unsourced };
}

// The invented-source check. A model may write "Acme Directory confirms 020 7946 0000" or give numbers "from official
// sources" without looking anything up. These find the sources it names: "X confirms / says / lists / reports /
// shows", "according to X", "per X", "as listed on X", "source: X", a web address, and "official sources" said as a
// claim. A name is a capitalised phrase (up to 5 words) or a domain.
const NOT_A_SOURCE = new Set(('it this that these those he she they we i you who which what there here everyone someone '
  + 'nobody anyone one research science studies experts data history evidence everything nothing something the a an '
  + 'my your our their his her its google search the search my search').split(' '));
const SRC_NAME = "((?:the\\s+)?[A-Z][\\w.&'’-]*(?:\\s+(?:(?:of|de|the|and|for)\\s+){0,2}[A-Z][\\w.&'’-]*){0,4}|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|org|net|gov|edu|it|uk|de|fr|es|io|co|info|eu|int|au|ca)\\b)";
const SRC_BEFORE = new RegExp(`${SRC_NAME}\\s+(?:confirms|confirmed|says|said|states|stated|lists|listed|reports|reported|shows|showed|notes|noted|recommends|advises)\\b`, 'g');
const SRC_AFTER = new RegExp(`\\b(?:[Aa]ccording to|[Pp]er|[Aa]s (?:listed|stated|reported|shown|published) (?:on|by|in)|[Ss]ources?:|[Cc]ited by)\\s+${SRC_NAME}`, 'g');
const PER_UNIT = /^(?:the\s+)?(?:user|users|month|second|minute|hour|day|week|year|person|request|call|page|item|unit|cent|capita|annum|head|share|token|node|core|seat)s?$/i;
const VAGUE_CLAIM = /\b(?:(?:studies|research|experts|scientists|doctors|reports|the docs|the documentation|official guidelines)\s+(?:show|shows|showed|say|says|said|suggest|suggests|found|find|indicate|indicates|recommend|recommends|agree)|according to (?:research|studies|experts|the docs|the documentation))\b/gi;
// Claims that a tool or a page said something (every search had failed and no page was read, yet the model wrote
// "From the page: …" and "the tool filled in the details"). Backed only by a search that returned results or a page
// the model read, in this reply.
const TOOL_CLAIM = /\b(?:from the (?:page|article|website|site|search results|search|results)|the (?:page|article|website|site|search results|search|results|tool|lookup) (?:says|said|shows|showed|found|confirms|confirmed|filled in|lists|listed|states|stated|returned|gave)|(?:my|the) (?:search|lookup) (?:found|shows|showed|returned|confirmed|turned up)|according to (?:the )?(?:page|article|search results|search|results|tool)|based on (?:my|the) (?:search|results|lookup|page|article)|i (?:looked it up|looked this up|searched (?:for )?it|checked online|fetched the page))\b/gi;
// Text that presents itself as a tool run or a tool's output ("running web_search for ...", "web_search results: ...", "reading your
// earlier chat logs now"). With tools off a model can write a made-up "web_search results" list that holds the right number
// beside the wrong one. Backed only by a tool of that name that really ran in this reply, and the claim is named 'a <tool> run'.
const TOOL_WORD = '(web[ _-]?search|web[ _-]?fetch|run[ _-]?python|current[ _-]?time|search[ _-]?chats)';
const PY_HEADING = /(?:^|\n)[ \t>*_#-]*python\s+output\s*:/gi;
const toolKey = (w) => { const k = String(w).toLowerCase().replace(/[ -]/g, '_').replace(/^(web|run|current|search)(?=(search|fetch|python|time|chats)$)/, '$1_'); return k === 'python' ? 'run_python' : k; };
// Each form says a tool ran or what it returned: a verb that says it is running the tool ("running web_search"), a heading for its
// output ("web_search results:", "Results from web_search:", "Python output:"), or "<tool> found/says/shows/gave" (not "found
// nothing" or an error). A sentence that denies, doubts or offers it ("I haven't used web_search", "I can try using web_search",
// "without calling it") is not a claim; flagging honest phrasings like these would train readers to ignore the warning.
const FAKE_RUN = new RegExp(`\\b(?:(?:running|ran|calling|called|executing|executed|using|used)\\s+${TOOL_WORD}\\b`
  + `|${TOOL_WORD}\\s+(?:results?|output)\\s*(?::|\\n|$)|results?\\s+from\\s+${TOOL_WORD}\\s*:`
  + `|${TOOL_WORD}\\s+(?:found|says|shows|gave|returned)\\b(?!\\s+(?:nothing|no\\b|none|zero|an?\\s+error|not\\b|that\\s+tools?\\b))\\s*[:\\w'"-]?)`, 'gi');
const FAKE_CHATS = /\b(?:reading|searching|checking|looking (?:through|at)|going through)\s+(?:your|my|our|the)\s+(?:earlier|past|previous|old)?\s*(?:chat\s*logs?|chats|conversations?)\s+now\b/gi;
const DENIAL = /\b(?:not|never|without|cannot|unless|if|try|trying|didn't|haven't|hadn't|don't|doesn't|won't|can't|wouldn't|couldn't|isn't|aren't|wasn't)\b|n['’]t\b/i;
const WEAK_DENIAL = /^(?:can|could|would|will|shall|should|might|may|want|wanted|no)$/i;
// The few words before a match, in the same sentence, hold a denial or an offer: a strong word within 4 words, or a weak one
// ("can", "will", "no") right before it, so "As you can see, web_search results:" and "No worries, running web_search" still count.
const deniedBefore = (text, at) => {
  const before = text.slice(0, at); const start = Math.max(before.lastIndexOf('\n'), before.search(/[.!?]\s+[^.!?]*$/));
  const words = before.slice(Math.max(0, start)).split(/\s+/).filter(Boolean);
  return DENIAL.test(words.slice(-4).join(' ')) || WEAK_DENIAL.test((words[words.length - 1] || '').replace(/[^\w']/g, ''));
};
const isFakeRun = (n) => /^a (?:web_search|web_fetch|run_python|current_time|search_chats) run$/.test(n) || n === 'a tool_response block';
const isToolClaim = (n) => /^(?:from the|(?:the )?(?:page|article|website|site|search|results|tool|lookup) (?:says|said|shows|showed|found|confirms|confirmed|filled|lists|listed|states|stated|returned|gave|results)|my (?:search|lookup)|according to (?:the )?(?:page|article|search|results|tool)|based on (?:my|the)|i (?:looked|searched|checked|fetched))\b/.test(n);
// A claim about "the tool" is backed by any tool that really ran in this reply (a Python run, the clock, a past-chat search)
// as well as by web results ("I ran it: the tool returned 42" is true).
const isToolWord = (n) => /\btool\b/.test(n);
const RAN_TOOLS = /^(?:run_python|current_time|search_chats)$/;
const isVague = (n) => isToolClaim(n) || n === 'official sources' || /^(?:studies|research|experts|scientists|doctors|reports|(?:the )?docs|(?:the )?documentation|official guidelines|according to)\b/.test(n);
function sourceClaims(text) {
  const t = text || ''; const out = []; const seen = new Set();
  const add = (raw) => {
    const name = String(raw).replace(/^the\s+/i, '').replace(/['’]s$/, '').replace(/[.,;:]+$/, '').trim();
    const key = name.toLowerCase();
    if (!name || name.length < 3 || NOT_A_SOURCE.has(key) || seen.has(key)) return;
    seen.add(key); out.push(name);
  };
  for (const m of t.matchAll(SRC_BEFORE)) add(m[1]);
  for (const m of t.matchAll(SRC_AFTER)) {
    // "per Month", "per User": a unit, not a source.
    if (/^per\b/i.test(m[0]) && PER_UNIT.test(m[1].replace(/[.,;:!?]+$/, ''))) continue;
    add(m[1]);
  }
  // Vague claims, like "official sources": backed only by a real web search.
  for (const m of t.matchAll(VAGUE_CLAIM)) add(m[0].toLowerCase().replace(/\s+/g, ' '));
  for (const m of t.matchAll(TOOL_CLAIM)) add(m[0].toLowerCase().replace(/\s+/g, ' '));
  for (const m of t.matchAll(FAKE_RUN)) {
    if (deniedBefore(t, m.index)) continue;
    add(`a ${toolKey(m[1] || m[2] || m[3] || m[4])} run`);
  }
  for (const m of t.matchAll(FAKE_CHATS)) if (!deniedBefore(t, m.index)) add('a search_chats run');
  if (PY_HEADING.test(t)) add('a run_python run');
  PY_HEADING.lastIndex = 0;
  // A literal tool result written into the answer, the clearest fake of all.
  if (/<tool_response>[\s\S]*<\/tool_response>/i.test(t)) add('a tool_response block');
  // A bare web address names a source too.
  for (const m of t.matchAll(/\bhttps?:\/\/([a-z0-9.-]+\.[a-z]{2,})|\bwww\.([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)) add((m[1] || ('www.' + m[2])).replace(/^www\./i, ''));
  if (/\b(?:from|per|according to|checked with|verified with|via)\s+(?:the\s+)?official\s+(?:sources?|websites?|sites?|records?)\b/i.test(t)) add('official sources');
  return out;
}
// Each claimed source, found or not in what the model saw: case-insensitive, also with spaces and dots taken out, so
// "Acme Directory" matches acmedirectory.example. "official sources" counts as
// found only when one of the tool results came from the web.
function checkSources(names, sources) {
  const found = []; const unsourced = [];
  const flat = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  for (const n of names) {
    let src;
    if (isFakeRun(n)) {
      // Any attempt of that tool in the reply backs it, failed or not; a made-up number is still caught by the number check.
      const tool = n.split(' ')[1];
      src = n === 'a tool_response block' ? sources.find((s) => /^(?:web_search|web_fetch|run_python|current_time|search_chats)$/.test(s.name))
        : sources.find((s) => s.name === tool);
    }
    else if (isVague(n)) {
      src = sources.find((s) => (s.name === 'web_search' && /https?:\/\//.test(s.text)) || /^web_fetch\b/.test(s.name)
        || (isToolWord(n) && RAN_TOOLS.test(s.name) && s.ok !== false));
    }
    else {
      // A whole-word match ("Mum" is not in "minimum"), or the flattened form of 5+ characters for names
      // written as one word or a domain.
      const word = new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
      const f = flat(n);
      src = sources.find((s) => word.test(String(s.text || '')) || (f.length >= 5 && flat(s.text).includes(f)));
    }
    if (src) found.push({ name: n, source: src.name }); else unsourced.push(n);
  }
  return { found, unsourced };
}

const SHORT_CALL = /\b(?:call|calling|dial|dialling|dialing|text|texting|phone|ring)\b(?:\W+\w+)?\W+[*_(]*$/i;
const SERVICE = /\b(?:police|ambulance|fire|fire ?brigade|firefighters?|emergency|emergencies|poison|coast ?guard|rescue|hospital|helpline|hotline|lifeline|crisis line|samaritans|nhs|non-emergency|landline|freephone|toll[- ]free)\b/i;
const SHORT_UNIT = /^\s*(?:ms|s|sec|secs|seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|%|percent|times|x\b|beds?|lines?|rows?|people|persons?|users?|items?|calls?|requests?|tokens?|steps?|bytes?|kb|mb|gb|tb|px|pt|km|m|cm|mm|kg|g|mg|ml|l|euros?|dollars?|pounds?|€|\$|£|errors?|pages?|words?|characters?|chars?)\b/i;

function checkFlags(text) {
  const flags = [];
  const seen = new Set();
  const add = (type, match) => {
    const key = `${type}:${match}`;
    if (!seen.has(key)) { seen.add(key); flags.push({ type, match }); }
  };
  const t = text || '';
  // Leans toward over-flagging, but not on plain maths.
  // Service words count as contact words too: "City Police 020 7946 0000" with no other contact word must not go unmarked.
  const CONTACT = /\b(call|calling|text|dial|phone|line|lifeline|hotline|helpline|number|numbers|contact|reach|sms|police|ambulance|fire|firefighters?|emergency|emergencies|hospital|poison|rescue|coast ?guard|non-emergency)\b/i;
  const inContact = (i) => CONTACT.test(t.slice(Math.max(0, i - 60), i + 1));
  const spans = [];   // where longer numbers are, so a short one inside them isn't counted again
  const flagEnds = []; // where flagged numbers end, for a short number given right after one
  // Dots count as separators too ("020.7946"), but a number written with dots needs a
  // contact word, so 3.1415926 is never a phone number.
  for (const m of t.matchAll(/\+?\d[\d\s().-]{3,}\d/g)) {
    spans.push([m.index, m.index + m[0].length]);
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, '');
    const groups = raw.split(/[\s().-]+/).filter(Boolean);
    const dotted = /\d\.\d/.test(raw);
    // Not phone numbers unless next to a contact word: counting ("1 2 3 … 10"), ranges
    // ("1400-1500"), and arithmetic with a spaced minus ("7394401 - 748225").
    const counting = groups.length >= 4 && groups.every((g) => g.length <= 2);
    const range = groups.length === 2 && groups.every((g) => g.length <= 4);
    const arithmetic = /\s-\s/.test(raw);
    // An ISO date ("2026-11-25") has the shape of a phone number but is not one.
    const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    const phoneShaped = /^\+/.test(raw) || (!dotted && (/^1[\s-]?8\d\d/.test(raw)
      || (digits.length >= 7 && groups.length >= 2 && !counting && !range && !arithmetic && !isoDate)));
    if (digits.length >= 5 && !counting && (inContact(m.index) || phoneShaped)) { add('number', raw); flagEnds.push(m.index + m[0].length); }
  }
  // Short service numbers: any 3-digit number next to a contact word (a fixed list of emergency numbers would miss
  // other countries'), and 4-digit ones from 1000 to 1899. (Not 19xx or 20xx: those read as years.)
  // And a bare 4-digit run starting with 0 ("Information Service at 0800", a freephone prefix given as
  // if it were the whole number).
  // A short number counts only right after call / dial / text / phone / ring (within two words), or in a sentence with
  // a service word, and never with a unit after it ("200 ms", "300 beds", "line 120" and "error number 404" are not
  // phone numbers).
  for (const m of t.matchAll(/(?<![\d.,])(1[0-8]\d\d|0\d{3}|\d{3})(?!\d)(?![.,]\d)/g)) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b && b - a > m[0].length)) continue;
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 14);
    if (SHORT_UNIT.test(after)) continue;
    const before = t.slice(Math.max(0, m.index - 40), m.index);
    const s0 = Math.max(t.lastIndexOf('\n', m.index), ...['. ', '! ', '? '].map((x) => t.lastIndexOf(x, m.index)));
    const ends = ['. ', '! ', '? ', '\n'].map((x) => t.indexOf(x, m.index)).filter((x) => x >= 0);
    const sentence = t.slice(s0 < 0 ? 0 : s0, ends.length ? Math.min(...ends) : t.length);
    // Or right after another number the model gave ("call 0800 (or 0845 from a mobile)").
    const nearNumber = flagEnds.some((e) => e <= m.index && m.index - e <= 25 && !/[.!?;\n]/.test(t.slice(e, m.index)));
    if (SHORT_CALL.test(before) || SERVICE.test(sentence) || nearNumber) { add('number', m[0]); flagEnds.push(m.index + m[0].length); }
  }
  // Doses: a number with a unit, or a count of tablets, pills, capsules or drops.
  for (const m of t.matchAll(/\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|ml|mL|g|IU|units?|tablets?|pills?|capsules?|drops?|puffs?)\b/gi)) add('dose', m[0]);
  for (const m of t.matchAll(/\b(?:one|two|three|four|five|six|half an?|a)\s+(?:tablets?|pills?|capsules?)\b/gi)) add('dose', m[0]);
  for (const m of t.matchAll(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g)) add('email', m[0]);
  for (const m of t.matchAll(/\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+|\b[a-z0-9-]+\.(?:com|org|net|gov|edu|io|co|uk|ca|au|info)\b/gi)) {
    if (!flags.some((f) => f.type === 'email' && f.match.includes(m[0]))) add('link', m[0]);
  }
  return { flags, sensitive: SENSITIVE_WORDS.test(t) };
}

// "How does the model know it": a mark per sentence, from what the harness can actually
// observe. It never claims to read the model's mind: "not checked" means only that no
// tool result or message from the user backs the sentence.
//   checked     a number in the sentence came out of a tool the model ran in this reply
//   told        a number in the sentence was given by the user earlier in the chat
//   prompt      the sentence matches the system prompt
//   unverified  a phone number, dose, link or email (see checkFlags)
//   unsure      the model says it doesn't know or can't check
//   unchecked   everything else
const numbersIn = (t) => ((t || '').match(/\d[\d,]*(?:\.\d+)?/g) || [])
  .map((n) => n.replace(/,/g, '').replace(/\.$/, '')).filter((n) => n.length >= 2);
const UNSURE = /\b(i (?:do not|don't|don’t) know|i(?:'|’)?m not sure|not certain|i can(?:'t|’t|not) (?:actually )?(?:check|know|verify|tell|access|browse)|i (?:do not|don't|don’t) have (?:access|a clock|a way|live)|no way (?:for me )?to (?:check|know))\b/i;

// Distinctive words of the system prompt: names (capitalised mid-sentence) and longer words.
const NOTE_STOP = new Set(['about', 'after', 'again', 'answer', 'because', 'before', 'being', 'could', 'every', 'first',
  'other', 'right', 'something', 'sometimes', 'their', 'there', 'these', 'thing', 'things', 'those', 'unless', 'until',
  'what’s', 'where', 'which', 'while', 'would', 'wrong', 'yourself', 'matters', 'starts', 'speaking', 'message', 'someone',
  'from', 'your', 'have', 'with', 'that', 'this', 'team', 'made', 'were', 'what', 'when', 'each', 'like', 'they', 'them',
  'then', 'than', 'some', 'into', 'also', 'just', 'only', 'more', 'most', 'very', 'been', 'does', 'done', 'good', 'true',
  'fine', 'kind', 'sure', 'know', 'don’t', 'can’t', 'isn’t', "don't", "can't", "isn't", 'here', 'time', 'past', 'point',
  'tells', 'says', 'said', 'when', 'you’ve', 'you’re', 'equal', 'help', 'fresh', 'start', 'thing', 'using', 'yours']);
function noteTerms(note) {
  const names = new Set(); const words = new Set();
  for (const m of (note || '').matchAll(/(?<=[a-z,;:’'] )([A-Z][A-Za-z0-9.]{2,})/g)) names.add(m[1].toLowerCase());
  for (const w of (note || '').toLowerCase().match(/[a-z_][a-z_’']{3,}/g) || []) if (!NOTE_STOP.has(w)) words.add(w);
  return { names, words };
}

function markReply(text, toolLog = [], peopleTexts = [], note = '') {
  const terms = noteTerms(note);
  const toolNums = new Set();
  for (const t of toolLog) if (t.decision === 'ran' && t.ok !== false) numbersIn(t.output).forEach((n) => toolNums.add(n));
  const toldNums = new Set();
  for (const p of peopleTexts) numbersIn(p).forEach((n) => toldNums.add(n));
  const out = [];
  let inCode = false;
  for (const line of (text || '').split('\n')) {
    if (line.trim().startsWith('```')) { inCode = !inCode; out.push({ text: line, mark: null, nl: true, fence: true }); continue; }
    if (inCode || !line.trim()) { out.push({ text: line, mark: null, nl: true, code: inCode }); continue; }
    let first = true; // nl marks the first sentence of each line, so the page can keep the model's line breaks
    for (const sentence of line.split(/(?<=[.!?])\s+(?=[A-Z*"'(\d])/)) {
      const nums = numbersIn(sentence);
      // Questions and short pleasantries make no claim, so they carry no mark.
      const words = sentence.trim().split(/\s+/).length;
      const noClaim = /\?\s*$/.test(sentence.trim()) || (words <= 4 && !nums.length && !/\b(is|are|was|were|has|have)\b/i.test(sentence));
      if (noClaim && !checkFlags(sentence).flags.length) { out.push({ text: sentence, mark: null, nl: first }); first = false; continue; }
      let mark = 'unchecked';
      if (checkFlags(sentence).flags.length) mark = 'unverified';
      else if (nums.some((n) => toolNums.has(n))) mark = 'checked';
      else if (nums.some((n) => toldNums.has(n))) mark = 'told';
      else if (UNSURE.test(sentence)) mark = 'unsure';
      else {
        // From the system prompt: it names something the prompt names, or shares two of its words.
        const sw = new Set(sentence.toLowerCase().match(/[a-z_][a-z0-9_.’']{2,}/g) || []);
        const has = (set) => [...set].filter((t) => sw.has(t) || sw.has(t + 's') || [...sw].some((w) => w.startsWith(t))).length;
        if (has(terms.names) >= 1 || has(terms.words) >= 2) mark = 'prompt';
      }
      out.push({ text: sentence, mark, nl: first }); first = false;
    }
  }
  const conf = (text || '').match(/(\d{1,3})\s?%\s*(?:sure|certain|confident)|(?:sure|certain|confident)[^.\n]{0,20}?(\d{1,3})\s?%/i);
  const stated = conf ? Math.min(100, Number(conf[1] || conf[2])) : null;
  return { sentences: out, stated_confidence: stated };
}

// ---- arithmetic that does not work out ----

const num = (x) => Number(String(x).replace(/,/g, '').replace('−', '-'));
const decimals = (x) => (String(x).split('.')[1] || '').length;
const OPS = { '+': (a, b) => a + b, '-': (a, b) => a - b, '−': (a, b) => a - b, '*': (a, b) => a * b, '×': (a, b) => a * b,
  x: (a, b) => a * b, '/': (a, b) => a / b, '÷': (a, b) => a / b };
const ARITH = /(\d[\d,]*(?:\.\d+)?)\s*([×*+\-−÷/]| x )\s*(\d[\d,]*(?:\.\d+)?)\s*=\s*(-?\d[\d,]*(?:\.\d+)?)/g;
// A comma followed by one or two digits is a decimal comma ("3,5"), not a thousands group (always three digits): such
// a sum is skipped, since it can't be read safely.
const DECIMAL_COMMA = /,\d{1,2}(?!\d)/;
const flatText = (x) => String(x || '').replace(/\s+/g, '').toLowerCase();

// Statements like "17 × 24 = 418" that do not hold. Chains ("a*b + c*d = e + f = g") are
// skipped: only a lone "a op b = c" is judged.
// `seen`: texts a sum may have been quoted from (the user's messages, this reply's tool outputs). A sum that appears
// there word for word is still judged, since it is wrong whoever wrote it ("Yes, 17 × 24 = 418" endorses the
// user's wrong sum), but it is marked quoted so the page can say it is not the model's own slip.
function arithmeticSlips(text, seen = []) {
  const out = [];
  const t = text || '';
  const seenFlat = (Array.isArray(seen) ? seen : [seen]).map(flatText).join('\n');
  for (const m of t.matchAll(ARITH)) {
    const before = t.slice(0, m.index).trimEnd().slice(-1);
    const after = t.slice(m.index + m[0].length).trimStart().slice(0, 1);
    // ':' before or after: a time (10:30 + 2) or a ratio (16:9 / 2), not a sum.
    if (/[\d+\-−*×÷/=(^.:]/.test(before) || /[+\-−*×÷/=^(%:]/.test(after)) continue;
    if (DECIMAL_COMMA.test(m[0])) continue;
    const quoted = Boolean(seenFlat && seenFlat.includes(flatText(m[0].replace(/,+$/, ''))));
    const op = m[2].trim();
    const actual = OPS[op](num(m[1]), num(m[3]));
    const claimed = num(m[4]);
    if (!Number.isFinite(actual)) continue;
    // A decimal may be rounded or cut off ("73.666..."): allow one unit in its last place.
    // A whole-number claim must be exact when the true result is whole, else within rounding.
    const dec = decimals(m[4]);
    const tol = (dec > 0 ? 10 ** -dec : (Number.isInteger(actual) ? 0 : 0.5)) + 1e-9;
    if (Math.abs(actual - claimed) > tol) {
      out.push({ expr: `${m[1]} ${op} ${m[3]}`, claimed: m[4].replace(/,+$/, ''), actual: String(Number(actual.toFixed(6))), ...(quoted ? { quoted: true } : {}) });
    }
  }
  return out;
}

// Context size beyond which a small model tends to mix up threads. Shown to the user as a suggestion to
// start a fresh chat.
const LONG_CONTEXT_TOKENS = Number(process.env.LH_LONG_CONTEXT_TOKENS || 6000);

function makeMessage({ convId, author, text, extra = {} }) {
  if (!AUTHORS[author]) throw new Error(`unknown author: ${author}`);
  return {
    id: newId('m'),
    conv_id: convId,
    ts: new Date().toISOString(),
    author,
    source: AUTHORS[author].source,
    text,
    ...extra,
  };
}

// Readable view of one conversation's event log.
function renderLogMarkdown(convId, events) {
  const lines = [
    `# Activity log: ${convId}`,
    '',
    `> ${THINKING_CAVEAT}`,
    '',
    'Kept on this computer only, under the data folder.',
    '',
  ];
  let turn = 0;
  for (const e of events) {
    if (e.type === 'message' && e.author !== 'model') {
      const who = e.author === 'tool' ? 'Tool result' : 'User';
      lines.push(`**${who}** (${e.ts}): ${e.text}`, '');
    } else if (e.type === 'model_call') {
      turn += 1;
      lines.push(`## Turn ${turn}`, '',
        `- Sent ${e.messages.length} message(s) (sha256 ${e.messages_sha.slice(0, 12)}), ` +
        `model ${(e.model && e.model.id) || 'unknown'}, ` +
        `temperature ${e.temperature}${e.sampling && e.sampling.top_p != null ? `, top_p ${e.sampling.top_p}` : ''}${e.sampling && e.sampling.top_k != null ? `, top_k ${e.sampling.top_k}` : ''}, max ${e.max_tokens} tokens`, '');
    } else if (e.type === 'reply') {
      if (e.skip_facts && e.skip_facts.length) lines.push(`- **Skipped thinking.** What the harness saw: ${e.skip_facts.join('; ')}. (Facts about the turn, not the model's reasons.)`);
      lines.push(`- **First move:** ${e.first_move}`,
        `- Finished: ${e.finished ? 'yes' : 'no'} (finish reason: ${e.finish_reason || 'n/a'}), ` +
        `${e.seconds.toFixed(1)} s` + (e.usage ? `, ${e.usage.completion_tokens || '?'} tokens written` : ''),
        '', '<details><summary>Thinking</summary>', '', '```', e.thinking || '(none)', '```', '', '</details>', '',
        `**Reply:** ${e.text || '(no answer)'}`, '');
      if (e.check_flags && e.check_flags.length) {
        lines.push(`- **Check this** (unverified specifics): ${e.check_flags.map((f) => `${f.type} \`${f.match}\``).join(', ')}`, '');
      }
      if (e.sensitive) lines.push('- **Sensitive topic** (medical, crisis or safety): verify before relying on it.', '');
      if (e.context_tokens) lines.push(`- Context carried: ${e.context_tokens} tokens`, '');
    } else if (e.type === 'tool_attempt') {
      const code = e.args && e.args.code ? e.args.code : JSON.stringify(e.args);
      lines.push(`- **Reached for \`${e.name}\`** (trust: ${e.trust || 'n/a'}; decision: **${e.decision}**` +
        `${e.in_thinking ? '; called from inside its thinking' : ''})`, '',
        '```python', code, '```', '', 'Output:', '', '```', e.output || '', '```', '');
    } else if (e.type === 'harness') {
      lines.push(`_harness: ${e.event}${e.detail ? ` (${e.detail})` : ''}_`, '');
    }
  }
  const replies = events.filter((e) => e.type === 'reply');
  const empty = replies.filter((e) => !(e.text || '').trim()).length;
  const flagged = replies.reduce((n, e) => n + ((e.flagged_specifics || e.check_flags || []).length), 0);
  const flaggedReplies = replies.filter((e) => (e.flagged_specifics || e.check_flags || []).length).length;
  lines.splice(6, 0, `Replies so far: ${replies.length}; with no answer (thinking only, or blank): ${empty}.`,
    `Unverified specifics flagged: ${flagged}, in ${flaggedReplies} replies (phone numbers, doses, links, emails).`, '');
  return lines.join('\n');
}

// ---- small file helpers ----

// The folder that holds src/, trust.json and data/.
function projectRoot() {
  return path.resolve(__dirname, '..');
}

// Everything the harness writes goes under one folder: ./data next to src/, or LH_DATA.
function dataDir() {
  return process.env.LH_DATA || path.join(projectRoot(), 'data');
}

// An optional system prompt the user writes: LH_SYSTEM_PROMPT (a file path), else <data>/system_prompt.txt.
// There is none by default; nothing is sent as a system message unless this file exists.
function systemPrompt() {
  try { return fs.readFileSync(process.env.LH_SYSTEM_PROMPT || path.join(dataDir(), 'system_prompt.txt'), 'utf8'); } catch { return ''; }
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

module.exports = {
  AUTHORS, THINKING_CAVEAT,
  newId, sha256, buildModelMessages, splitReply, firstMove, skipFacts, checkFlags, sourceNumbers, sourceClaims, checkSources, markReply, arithmeticSlips, LONG_CONTEXT_TOKENS,
  makeMessage, renderLogMarkdown, projectRoot, dataDir, systemPrompt, appendJsonl, readJsonl,
};

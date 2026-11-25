// Think harder: an opt-in mode for ONE coding question. The model writes 8 tries and a set of test inputs for the
// problem; each try is run in the sandbox on those inputs; the try whose behaviour agrees with the most other tries is
// shown. An optional repair round gives the closest failing try one chance to fix itself.
//
//   tries      8 replies drawn from the model server
//   inputs     one more reply: up to 8 one-line calls of the function (or class) the question names
//   checking   each try loads and runs on every input in the sealed sandbox (sandbox.js); the only thing kept from
//              an input is a short hash of what it returned, or the exception type it raised
//   pick       a try "survives" if it loads and no input crashes it (a raise the question asks for is behaviour, not a
//              crash); survivors are grouped by behaviour on the inputs, and the biggest group wins (ties: the
//              group with the earlier try; inside the group, the shortest reply)
//   repair     (optional) if no try survived: the loaded try with the fewest crashes gets its first crashing input and
//              the error text, and one fixed version is checked on the same inputs
//
// Nothing here knows the right answer. It only measures agreement, so it can pick a wrong try that most tries share.
// Two simplifications: whether a reply "parses" is not checked up front (Python's own loader in the sandbox reports a
// syntax error, which then counts as a load failure), and inputs are checked for being calls of a function the question
// names with a small parser written for this, not Python's.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const sandbox = require('./sandbox');

const TRIES = 8;
const MAX_INPUTS = 8;
const INPUT_SECONDS = 2;   // per input (and for loading), inside the sandbox script

const read = (name) => { try { return fs.readFileSync(path.join(__dirname, name), 'utf8').trim(); } catch { return null; } };
const inputsInstruction = () => read('think_harder_inputs.md');
const repairInstruction = () => read('think_harder_repair.md');

// ---- code and inputs ----

// The code of a reply: its last fenced block, or the whole text when it has no fence but looks like code.
function codeOf(text) {
  const blocks = [...String(text || '').matchAll(/```(?:python|py)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.trim());
  if (blocks.length) return blocks[blocks.length - 1];
  return /^\s*(def|class|import|from)\s/m.test(text || '') ? String(text) : null;
}

const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const named = (word, prompt) => new RegExp(`\\b${escapeRe(word)}\\b`).test(prompt);

// Split at top-level `sep` characters, respecting brackets and string literals.
function splitTop(s, sep = ',') {
  const out = []; let depth = 0; let q = null; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (depth === 0 && c === sep) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
// The index just past the bracket that closes the one at `at`, or -1.
function closeAt(s, at) {
  let depth = 0; let q = null;
  for (let i = at; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

// Is the whole expression a call of a function the question names (a chain such as Cls().method(1) counts)?
// A bare name, a literal, print(...) or a wrapper such as isinstance(f(1), list) is not: it would give every try the
// same value, or carry the expected value along.
function isCall(expr, prompt) {
  let s = expr.trim(); let lastName = null; let calls = 0;
  for (;;) {
    const m = s.match(/^([A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/);
    if (!m) return false;
    lastName = m[1].split('.').pop().trim();
    const end = closeAt(s, m[0].length - 1);
    if (end < 0) return false;
    calls++;
    s = s.slice(end).trim();
    if (!s) break;
    if (!s.startsWith('.')) return false;
    s = s.slice(1).trim();
  }
  return calls > 0 && lastName !== 'print' && named(lastName, prompt);
}

const bindsName = (e) => /^[A-Za-z_]\w*\s*:=/.test(e.trim());
// The class form: `[obj := ClassName(), obj.method(1), obj.other()][-1]`, as a list or a tuple, with or without [-1].
function isClassLine(expr, prompt) {
  let s = expr.trim();
  const m = s.match(/\[\s*-1\s*\]$/);
  if (m) s = s.slice(0, s.length - m[0].length).trim();
  if (!(s.startsWith('[') || s.startsWith('(')) || closeAt(s, 0) !== s.length) return false;
  const elts = splitTop(s.slice(1, -1)).map((e) => e.trim()).filter(Boolean);
  if (!elts.some(bindsName)) return false;
  return elts.every((e) => (bindsName(e) ? isCall(e.replace(/^[A-Za-z_]\w*\s*:=\s*/, ''), prompt) : isCall(e, prompt)));
}
const isInput = (e, prompt) => isCall(e, prompt) || isClassLine(e, prompt);

// The left side of a top-level comparison (`CALL == X`), or the whole text.
function leftOfCompare(s) {
  let depth = 0; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (depth === 0 && /^(==|!=|<=|>=)/.test(s.slice(i))) return s.slice(0, i);
    if (depth === 0 && /^( is | in | not in )/.test(s.slice(i))) return s.slice(0, i);
  }
  return s;
}
function callIn(text, prompt) {
  let s = leftOfCompare(text.trim()).trim();
  if (/^not\s+/.test(s)) s = s.replace(/^not\s+/, '');
  return isInput(s, prompt) ? s : null;
}

// The calls in one line of the model's test-input reply, as source text. A plain call is kept as written. Otherwise the
// call is salvaged from `CALL == X`, `assert CALL == X`, `assert CALL`, `CALL should raise ...` and `CALL1, X, CALL2` (a
// tuple or list line: its calls only). The class form is kept whole. Anything else gives nothing.
function lineCalls(line, prompt) {
  const s = line.trim();
  if (isInput(s, prompt)) return [s];
  if (/^assert\s/.test(s)) { const c = callIn(s.slice(7), prompt); return c ? [c] : []; }
  const should = s.match(/^(.+?)\s+should\b/);
  if (should && isInput(should[1], prompt)) return [should[1].trim()];
  const parts = splitTop(s);
  const bracketed = (s.startsWith('[') || s.startsWith('(')) && closeAt(s, 0) === s.length;
  const elts = bracketed ? splitTop(s.slice(1, -1)) : parts;
  if (bracketed || parts.length > 1) {
    if (elts.some(bindsName)) return [];
    return elts.map((e) => callIn(e, prompt)).filter(Boolean);
  }
  const c = callIn(s, prompt);
  return c ? [c] : [];
}

// The test inputs from the model's reply: one call per line, from its last code block (or the whole text). Repeats are
// dropped. At most MAX_INPUTS. A reply that was cut off gives none.
function parseInputs(reply, prompt) {
  if (!reply || reply.finished === false) return [];
  const text = String(reply.text || '');
  const blocks = [...text.matchAll(/```(?:python|py)?[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const body = blocks.length ? blocks[blocks.length - 1] : text;
  const out = [];
  for (const line of body.split('\n')) {
    const s = line.trim().replace(/,$/, '');
    if (!s || s.startsWith('#')) continue;
    for (const c of lineCalls(s, prompt)) if (!out.includes(c)) out.push(c);
    if (out.length >= MAX_INPUTS) break;
  }
  return out.slice(0, MAX_INPUTS);
}

// ---- the check script, run once per try in the sandbox ----

const CHECK_TEMPLATE = String.raw`import contextlib, hashlib, io, math, re, signal, sys
SRC = __SRC__
CASES = __CASES__
OUT = sys.stdout
ADDR = re.compile(r" at 0x[0-9a-fA-F]+")
def canon(x, depth=0):
    # Equal behaviour must hash equal in every container: sets and dicts are ordered by string hashing (random per
    # process), default reprs carry addresses, floats differ in the last digits between equivalent algorithms.
    if depth > 20:
        return "..."
    if isinstance(x, bool) or x is None or isinstance(x, (int, str, bytes)):
        return x
    if isinstance(x, float):
        if math.isnan(x):
            return "nan"
        if math.isinf(x):
            return "inf" if x > 0 else "-inf"
        x = round(x, 9)
        return int(x) if x.is_integer() else x
    if isinstance(x, complex):
        return ("complex", canon(x.real), canon(x.imag))
    if isinstance(x, (set, frozenset)):
        return ("set", sorted(repr(canon(v, depth + 1)) for v in x))
    if isinstance(x, dict):
        return ("dict", sorted((repr(canon(k, depth + 1)), repr(canon(v, depth + 1))) for k, v in x.items()))
    if isinstance(x, (list, tuple)):
        return (type(x).__name__, [canon(v, depth + 1) for v in x])
    try:
        return ("obj", type(x).__name__, ADDR.sub("", repr(x)))
    except BaseException:
        return ("obj", type(x).__name__)
def mark(s):
    OUT.write("@@TH " + s.replace("\n", " ")[:200] + "\n"); OUT.flush()
def alarm(*a):
    raise TimeoutError("over __SECS__ s")
signal.signal(signal.SIGALRM, alarm)
ns = {"__name__": "solution"}
sink = io.StringIO()
try:
    signal.alarm(__SECS__)
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        exec(compile(SRC, "solution.py", "exec"), ns)
    signal.alarm(0)
except BaseException as e:
    signal.alarm(0)
    mark("LOADFAIL " + type(e).__name__ + ": " + str(e))
    raise SystemExit(0)
mark("LOADED")
for i, case in enumerate(CASES):
    try:
        signal.alarm(__SECS__)
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            r = eval(case, ns)
        signal.alarm(0)
        mark(str(i) + " OK " + hashlib.sha1(repr(canon(r)).encode()).hexdigest()[:16])
    except BaseException as e:
        signal.alarm(0)
        mark(str(i) + " EXC " + type(e).__name__ + ": " + str(e))
    sink.seek(0); sink.truncate()
mark("DONE")
`;

// A JSON string is a valid Python string literal, and so is a JSON array of strings a Python list.
function checkScript(code, cases) {
  return CHECK_TEMPLATE.replace('__SRC__', () => JSON.stringify(code)).replace('__CASES__', () => JSON.stringify(cases))
    .split('__SECS__').join(String(INPUT_SECONDS));
}

// Run one try on all the inputs in one sandbox container. `runner(script, { timeoutMs })` resolves { output, seconds, ok }.
async function runCheck(code, cases, runner) {
  const res = await runner(checkScript(code, cases), { timeoutMs: (10 + INPUT_SECONDS * (cases.length + 1)) * 1000 });
  const out = String(res.output || '');
  const marks = out.split('\n').filter((l) => l.startsWith('@@TH ')).map((l) => l.slice(5));
  const rec = { loaded: marks.includes('LOADED'), done: marks.includes('DONE'), outputs: cases.map(() => null), errors: cases.map(() => null),
    load_error: null, seconds: res.seconds || 0, ...(res.unavailable ? { unavailable: true } : {}) };
  for (const m of marks) {
    if (m.startsWith('LOADFAIL ')) rec.load_error = m.slice(9);
    const sp = m.indexOf(' ');
    const head = sp < 0 ? m : m.slice(0, sp);
    if (/^\d+$/.test(head) && Number(head) < cases.length) {
      const rest = m.slice(sp + 1); const k = rest.indexOf(' ');
      const kind = k < 0 ? rest : rest.slice(0, k); const val = k < 0 ? '' : rest.slice(k + 1);
      if (kind === 'OK') rec.outputs[Number(head)] = val; else rec.errors[Number(head)] = val;
    }
  }
  if (!rec.loaded && rec.load_error === null) rec.load_error = out.trim().slice(0, 200) || 'no output';
  if (rec.loaded && !rec.done) {
    // The container stopped mid-run (a timeout): the first input with no mark is the culprit.
    for (let i = 0; i < cases.length; i++) {
      if (rec.outputs[i] === null && rec.errors[i] === null) { rec.errors[i] = out.trim() ? out.trim().split('\n').pop().slice(0, 200) : 'stopped'; break; }
    }
  }
  return rec;
}

// ---- selection ----

const ARG_TYPEERROR = /positional argument|required (?:positional|keyword|keyword-only) argument|unexpected keyword argument|got multiple values for argument|takes no arguments/;
// Not "error": questions use it for other things ("error message", "relative error").
const RAISE_WORDS = /\b(?:raise[sd]?|raising|exceptions?)\b/i;
const etype = (err) => err.split(':')[0].trim();

// The call itself failed, not the code under test: a NameError or AttributeError on a name the input uses and the
// question doesn't mention, a TypeError on the arguments, or an input that doesn't evaluate. A missing name inside
// the function body is not in the input, so it stays a crash of the code.
function callFailure(err, input, prompt) {
  const t = etype(err); const msg = err.includes(':') ? err.slice(err.indexOf(':') + 1) : '';
  if (t === 'NameError' || t === 'AttributeError') {
    const m = msg.match(t === 'NameError' ? /name '(\w+)' is not defined/ : /has no attribute '(\w+)'/);
    return Boolean(m) && named(m[1], input) && !named(m[1], prompt);
  }
  if (t === 'TypeError') {
    const m = msg.match(/^\s*([\w.]+)\(\)/);
    if (!(m && ARG_TYPEERROR.test(msg))) return false;
    const parts = m[1].split('.');
    // "Box.__init__() takes 1 positional argument": the input called Box(...), so use the class name before a dunder.
    while (parts.length > 1 && parts[parts.length - 1].startsWith('__') && parts[parts.length - 1].endsWith('__')) parts.pop();
    return named(parts[parts.length - 1], input);
  }
  return t === 'SyntaxError';
}

// Pick one try. `replies`: [{ text, finished }]. `cases`: the inputs ([] or null: no clustering). `only`/`most`: the
// inputs to use and, per input, whether most tries raised there (the repair re-check takes both from the main selection).
async function selectCode(prompt, replies, cases, runner, { only = null, most = null } = {}) {
  cases = cases || [];
  const cand = replies.map((r, j) => (r.finished !== false ? j : -1)).filter((j) => j >= 0);
  const codes = {}; for (const j of cand) codes[j] = codeOf(replies[j].text);
  const parsed = cand.filter((j) => codes[j] !== null);
  const n = cases.length;
  const checks = {};
  for (const j of parsed) checks[j] = await runCheck(codes[j], cases, runner);
  const loaded = parsed.filter((j) => checks[j].loaded && checks[j].done);
  let bad = []; let use;
  if (only === null) {
    bad = [...Array(n).keys()].filter((i) => loaded.length && loaded.every((j) => checks[j].errors[i] && callFailure(checks[j].errors[i], cases[i], prompt)));
    use = [...Array(n).keys()].filter((i) => !bad.includes(i));
  } else use = only.filter((i) => i < n);
  const talks = RAISE_WORDS.test(prompt);
  const mostRaised = {};
  for (const i of use) mostRaised[i] = most === null ? loaded.filter((j) => checks[j].errors[i]).length * 2 > loaded.length : Boolean(most[i]);
  const crash = (j, i) => { const err = checks[j].errors[i]; return Boolean(err) && !(named(etype(err), prompt) || (talks && mostRaised[i])); };
  const crashes = {};
  for (const j of parsed) if (checks[j].loaded) crashes[j] = use.filter((i) => crash(j, i));
  const surv = loaded.filter((j) => !crashes[j].length);
  const out = { candidates: cand, parsed, survivors: surv, checks, clustered: use.length > 0, inputs_bad: bad, inputs_used: use,
    crashes, talks, most_raised: mostRaised };
  if (surv.length && use.length) {
    const groups = new Map();
    for (const j of surv) {
      const sig = JSON.stringify(use.map((i) => (checks[j].outputs[i] !== null ? ['OK', checks[j].outputs[i]] : ['EXC', etype(checks[j].errors[i] || '')])));
      if (!groups.has(sig)) groups.set(sig, []);
      groups.get(sig).push(j);
    }
    const all = [...groups.values()];
    const best = all.reduce((a, b) => (b.length > a.length || (b.length === a.length && Math.min(...b) < Math.min(...a)) ? b : a));
    out.pick = best.reduce((a, b) => (replies[b].text.length < replies[a].text.length || (replies[b].text.length === replies[a].text.length && b < a) ? b : a));
    out.groups = all.map((g) => g.length).sort((a, b) => b - a);
    out.why = `biggest of ${all.length} behaviour group${all.length === 1 ? '' : 's'} (${best.length} of ${surv.length})`;
  } else if (surv.length) { out.pick = surv[0]; out.why = 'first try that loads (no inputs)'; }
  else if (parsed.length) { out.pick = parsed[0]; out.why = 'no try survived; first with code'; }
  else { out.pick = 0; out.why = 'no try has code; try 1'; }
  return out;
}

// (try, input, error) for the repair round: the loaded try with the fewest crashes, and its first crashing input.
function repairTarget(sel, cases) {
  let best = null;
  for (const [js, fails] of Object.entries(sel.crashes)) {
    if (!fails.length) continue;
    const key = [fails.length, Number(js)];
    if (best === null || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) {
      best = { key, j: Number(js), input: cases[fails[0]], error: sel.checks[js].errors[fails[0]] };
    }
  }
  return best ? { j: best.j, input: best.input, error: best.error } : null;
}

// The conversation so far, then the try, then the repair instruction with {case} and {error} filled in.
function repairMessages(messages, reply, input, error, instruction) {
  const note = instruction.split('{case}').join(input).split('{error}').join(error);
  return [...messages, { role: 'assistant', content: reply }, { role: 'user', content: note }];
}

// The messages that ask for test inputs: the conversation, with the instruction added to the last user turn.
function inputsMessages(messages, instruction) {
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (last && last.role === 'user') last.content = `${last.content}\n\n${instruction}`;
  else out.push({ role: 'user', content: instruction });
  return out;
}

// The whole run. `draw(messages)` asks the model once and resolves its chat-completion choice. `prompt` is the text of
// the question (and what came before it), used to check that inputs call a function the question names.
// `onProgress({ stage, done, total })` is called as it goes. Resolves { ok, choice, ... } or { ok: false, reason }.
async function think({ messages, prompt, draw, runner = sandbox.run, repair = false, onProgress = () => {}, tries = TRIES }) {
  const t0 = Date.now();
  const inputsNote = inputsInstruction();
  const repairNote = repair ? repairInstruction() : null;
  if (!inputsNote) return { ok: false, reason: 'src/think_harder_inputs.md is missing' };
  if (repair && !repairNote) return { ok: false, reason: 'src/think_harder_repair.md is missing' };
  const total = tries + 1;
  const choices = []; const replies = [];
  for (let j = 0; j < tries; j++) {
    onProgress({ stage: 'tries', done: j, total });
    const choice = await draw(messages);
    choices.push(choice); replies.push(lib.splitReply(choice));
  }
  onProgress({ stage: 'inputs', done: tries, total });
  const inputsChoice = await draw(inputsMessages(messages, inputsNote));
  const inputsReply = lib.splitReply(inputsChoice);
  const cases = parseInputs(inputsReply, prompt);
  onProgress({ stage: 'checking', done: total, total });
  const sel = await selectCode(prompt, replies, cases, runner);
  const unavailable = Object.values(sel.checks).some((c) => c.unavailable);
  if (unavailable) return { ok: false, reason: 'the sandbox stopped answering while the tries were being checked' };
  let pick = sel.pick; let choice = choices[pick]; let repaired = null;
  if (repairNote && cases.length && !sel.survivors.length) {
    const tgt = repairTarget(sel, cases);
    if (tgt) {
      onProgress({ stage: 'repair', done: total, total });
      const fixChoice = await draw(repairMessages(messages, replies[tgt.j].text, tgt.input, tgt.error, repairNote));
      const fix = lib.splitReply(fixChoice);
      const fsel = await selectCode(prompt, [fix], cases, runner, { only: sel.inputs_used, most: sel.most_raised });
      repaired = { from_try: tgt.j, input: tgt.input, error: tgt.error, survived: fsel.survivors.length > 0 };
      if (repaired.survived) { choice = fixChoice; }
    }
  }
  return { ok: true, choice, pick, why: sel.why, tries: replies.length, inputs: cases, survivors: sel.survivors,
    groups: sel.groups || [], repaired: Boolean(repaired && repaired.survived), repair: repaired, select: sel,
    reply_texts: replies.map((r) => r.text), inputs_text: inputsReply.text, seconds: Math.round((Date.now() - t0) / 100) / 10 };
}

module.exports = { TRIES, MAX_INPUTS, codeOf, splitTop, isCall, isClassLine, lineCalls, parseInputs, checkScript, runCheck, callFailure,
  selectCode, repairTarget, repairMessages, inputsMessages, think, inputsInstruction, repairInstruction };

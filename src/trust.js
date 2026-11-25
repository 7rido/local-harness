// Trust levels, read fresh from trust.json on every call so a change applies at once.
//
//   off   the tool is not offered to the model and never runs
//   ask   the model may call it, but the call waits for the user's yes (an approval card in the page)
//   on    the call runs by itself, and is shown under the reply
//
// "memory", "review", "think_harder" and "think_harder_repair" are feature switches rather than tools: "off", or
// "ask"/"on" (both mean on; the model's note offers always wait for the user's yes either way).
// "ask_someone" always asks: "on" behaves as "ask".
//
// Other keys in trust.json:
//   search_never_send   a list of words (your name, a street, a project name) that may never appear
//                       in a web search or a page address the model writes

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const LEVELS = ['off', 'ask', 'on'];
const DEFAULTS = { current_time: 'on', search_chats: 'on', web_search: 'off', web_fetch: 'off', run_python: 'off', memory: 'off',
  review: 'off', think_harder: 'off', think_harder_repair: 'off', ask_someone: 'off' };

const file = () => process.env.LH_TRUST_FILE || path.join(lib.projectRoot(), 'trust.json');

function read() {
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); return d && typeof d === 'object' ? d : {}; } catch { return {}; }
}

// The level of one tool or feature: the file's value when it is one of off / ask / on, else the safe default.
function level(name) {
  const v = read()[name];
  return LEVELS.includes(v) ? v : (DEFAULTS[name] || 'off');
}

function all() {
  const out = {};
  for (const name of Object.keys(DEFAULTS)) out[name] = level(name);
  return out;
}

const neverSend = () => { const l = read().search_never_send; return Array.isArray(l) ? l.filter((x) => typeof x === 'string') : []; };

module.exports = { LEVELS, DEFAULTS, file, level, all, neverSend };

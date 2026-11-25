// Questions the model put to a second voice (the ask_someone tool), after you approved them.
//
// An approved question is saved as an open ask in <data>/asks.jsonl. It is answered either by an endpoint
// (LH_TEACHER_URL, see teacher.js) or by a person or another program with `node src/cli.js answer <ask_id> "text"`.
// The answer is added to the chat as a turn by the author "teacher". Forgetting a chat deletes its asks.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const file = () => path.join(lib.dataDir(), 'asks.jsonl');
const rewrite = (rows) => {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
};

function addAsk({ convId, question, approvalId = null }) {
  const rec = { id: lib.newId('ask'), ts: new Date().toISOString(), conv_id: convId, approval_id: approvalId,
    question: String(question || '').trim(), status: 'open' };
  lib.appendJsonl(file(), rec);
  return rec;
}

const listAsks = (onlyOpen = false) => lib.readJsonl(file()).filter((x) => !onlyOpen || x.status === 'open');

// Close an open ask as answered; `via` says how ('cli' or 'endpoint').
function closeAsk(id, via = 'cli') {
  const rows = lib.readJsonl(file());
  const rec = rows.find((x) => x.id === id && x.status === 'open');
  if (!rec) return null;
  rec.status = 'answered'; rec.answered = new Date().toISOString(); rec.via = via;
  rewrite(rows);
  return rec;
}

// Forgetting a chat removes its asks.
function forgetConv(convId) {
  const rows = lib.readJsonl(file());
  const keep = rows.filter((x) => x.conv_id !== convId);
  if (keep.length !== rows.length) rewrite(keep);
  return rows.length - keep.length;
}

module.exports = { addAsk, listAsks, closeAsk, forgetConv };

// The miss log: replies known to be wrong, kept so the review can look at them.
//
// A miss is logged only when its answer can be checked:
//   - a rule can verify it (arithmetic the model stated that does not hold: lib.arithmeticSlips), or
//   - you marked the reply wrong and typed the right answer.
// Records hold the raw question and the raw reply: no system prompt, no harness wording. The file is
// <data>/misses.jsonl. Forgetting a chat deletes its misses.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const missFile = () => path.join(lib.dataDir(), 'misses.jsonl');

function listMisses() { return lib.readJsonl(missFile()); }

function logMiss({ convId, questionId, replyId, prompt, reply, check }) {
  const existing = listMisses();
  const key = `${replyId}|${check.kind}|${check.detail || ''}`;
  if (existing.some((x) => x.key === key)) return null;
  const rec = { id: lib.newId('miss'), key, ts: new Date().toISOString(), conv_id: convId, question_id: questionId || null,
    reply_id: replyId, prompt, reply, check };
  lib.appendJsonl(missFile(), rec);
  return rec;
}

// Forgetting reaches the log: remove misses by id or conversation.
function deleteMisses({ id, convId }) {
  const all = listMisses();
  const keep = all.filter((x) => !((id && x.id === id) || (convId && x.conv_id === convId)));
  if (keep.length !== all.length) {
    fs.mkdirSync(path.dirname(missFile()), { recursive: true });
    fs.writeFileSync(missFile(), keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''));
  }
  return all.length - keep.length;
}

module.exports = { listMisses, logMiss, deleteMisses, missFile };

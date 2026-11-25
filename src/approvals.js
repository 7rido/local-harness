// Approval records: tool calls (and note offers) that wait for the person's yes or no.
//
// A tool set to "ask" in trust.json does not run when the model calls it. The call is saved
// here as an open approval and shown in the page; the person approves (optionally after
// editing the code), or rejects it. One plain file: <data>/approvals.jsonl.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const file = () => path.join(lib.dataDir(), 'approvals.jsonl');
const rewrite = (rows) => {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), rows.map((x) => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : ''));
};

function addApproval({ convId, name, args }) {
  const rec = { id: lib.newId('apr'), ts: new Date().toISOString(), conv_id: convId, name, args, status: 'open' };
  lib.appendJsonl(file(), rec);
  return rec;
}

const listApprovals = (convId) => lib.readJsonl(file()).filter((x) => x.status === 'open' && (!convId || x.conv_id === convId));

// An open approval, without closing it: a note offer is saved before it is closed.
function getOpenApproval(id) { return lib.readJsonl(file()).find((x) => x.id === id && x.status === 'open') || null; }

function closeApproval(id, status) {
  const rows = lib.readJsonl(file());
  const rec = rows.find((x) => x.id === id && x.status === 'open');
  if (!rec) return null;
  rec.status = status; rec.closed = new Date().toISOString();
  rewrite(rows);
  return rec;
}

// Replace an approval's arguments (a note offer's text is dropped once the person has decided).
function setApprovalArgs(id, args) {
  const rows = lib.readJsonl(file());
  const rec = rows.find((x) => x.id === id);
  if (!rec) return null;
  rec.args = args; rewrite(rows);
  return rec;
}

// Forgetting a chat removes its approvals.
function forgetConv(convId) {
  const rows = lib.readJsonl(file());
  const keep = rows.filter((x) => x.conv_id !== convId);
  if (keep.length !== rows.length) rewrite(keep);
  return rows.length - keep.length;
}

module.exports = { addApproval, listApprovals, getOpenApproval, closeApproval, setApprovalArgs, forgetConv };

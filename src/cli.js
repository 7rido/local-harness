#!/usr/bin/env node
// A small command line for a running harness: list chats, start one, send a message, show a chat.
// It talks to the HTTP API with the token from the data folder, so it works only on the computer that runs the harness.
//
//   node src/cli.js list
//   node src/cli.js new
//   node src/cli.js send <conv_id> "text" [--thinking]
//   node src/cli.js show <conv_id> [--thinking]
//   node src/cli.js log <conv_id>

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');

const PORT = Number(process.env.LH_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;

function token() {
  const f = path.join(lib.dataDir(), 'token');
  if (!fs.existsSync(f)) throw new Error('no token: is the harness running? (node src/server.js)');
  return fs.readFileSync(f, 'utf8').trim();
}

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: { 'content-type': 'application/json', 'x-lh-token': token() },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(25 * 60 * 1000),
  });
  const type = res.headers.get('content-type') || '';
  const out = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(typeof out === 'string' ? out : out.error);
  return out;
}

function printMessage(m, showThinking) {
  const who = m.author === 'model' ? 'model' : m.author === 'tool' ? 'tool result' : 'you';
  if (m.author === 'model' && showThinking && m.thinking) console.log(`[thinking]\n${m.thinking}\n[/thinking]`);
  console.log(`${who}: ${m.text || '(no answer)'}`);
  if (m.author === 'model') console.log(`  (first move: ${m.first_move}; finished: ${m.finished ? 'yes' : 'no'})`);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));
  if (cmd === 'list') {
    const r = await call('GET', '/api/conversations');
    r.items.forEach((c) => console.log(`${c.id}  ${c.title}`));
  } else if (cmd === 'new') {
    const r = await call('POST', '/api/new');
    console.log(r.conv_id);
  } else if (cmd === 'send') {
    const [conv, text] = args;
    if (!conv || !text) throw new Error('usage: send <conv_id> "text" [--thinking]');
    const r = await call('POST', '/api/send', { conv_id: conv, text });
    if (r.reply) printMessage(r.reply, flags.has('--thinking'));
    else console.log(`no reply: ${r.failed ? r.failed.reason : 'unknown'}`);
  } else if (cmd === 'show') {
    const r = await call('GET', `/api/conv/${args[0]}`);
    r.messages.forEach((m) => printMessage(m, flags.has('--thinking')));
  } else if (cmd === 'log') {
    console.log(await call('GET', `/api/conv/${args[0]}/log`));
  } else {
    console.log('commands: list | new | send <conv> "text" [--thinking] | show <conv> [--thinking] | log <conv>');
    process.exitCode = cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => { console.error(String(err.message || err)); process.exitCode = 1; });

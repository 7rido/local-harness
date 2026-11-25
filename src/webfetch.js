// Read one web page for the model. Safety first, since a fetch could reach the user's own network:
//   1. http and https only, GET only, no cookies or credentials, a fixed generic client name, nothing saved to disk.
//   2. Never a private address. The host is looked up and checked inside the connection itself (the `lookup` hook), so
//      the page comes from exactly the address that was checked. Every address the name has must be public. Loopback,
//      private ranges, link-local (the cloud metadata address included), carrier-grade NAT, multicast and their IPv6
//      forms are refused, and so are localhost and .local names. Each redirect (at most 3) is checked again.
//   3. 10 s, 1 MB, text/html or text/plain only. Scripts, styles and page furniture are dropped; the model gets plain
//      text cut at 6,000 characters, with a marker when it was cut.
//   4. Never past a bot check or a CAPTCHA: a refusal is a plain failure.
// The search guard (websearch.guard) runs over the decoded address before this module is called (tools.js).
'use strict';

const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const TIMEOUT_MS = 10000;
const MAX_BYTES = 1024 * 1024;
const MAX_CHARS = 6000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Mozilla/5.0 (compatible)';

const BLOCKED = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, p, 'ipv4');
// Plus IPv4-compatible ::/96, site-local fec0::/10, and the two that carry an IPv4 address inside (6to4 2002::/16,
// Teredo 2001::/32).
for (const [a, p] of [['::', 96], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96],
  ['100::', 64], ['2002::', 16], ['2001::', 32]]) {
  BLOCKED.addSubnet(a, p, 'ipv6');
}
// An IPv4 address written inside IPv6 (::ffff:127.0.0.1) is checked as IPv4.
function isPrivate(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 6) {
    const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return BLOCKED.check(m[1], 'ipv4');
    return BLOCKED.check(ip, 'ipv6');
  }
  return BLOCKED.check(ip, 'ipv4');
}

const REASON = {
  scheme: 'only http and https addresses can be read',
  address: 'the address is not a valid web address',
  private: 'the address is on a private network',
  credentials: 'the address has a user name or password in it',
  port: 'only the usual web ports can be read',
  timeout: 'it took longer than 10 seconds',
  too_big: 'the page is larger than 1 MB',
  type: 'it is not a web page or plain text',
  redirects: 'it redirected too many times',
  status: (n) => `the site answered ${n}`,
  refused: 'the site refused the request',
  unreachable: 'the site could not be reached',
};

// Check an address before any connection: scheme, credentials, and names that are private by definition.
const WEB_PORTS = ['80', '443', '8080', '8443'];
function checkUrl(raw, ports = WEB_PORTS) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return { ok: false, why: REASON.address }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, why: REASON.scheme };
  if (u.username || u.password) return { ok: false, why: REASON.credentials };
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return { ok: false, why: REASON.address };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || host.endsWith('.lan') || host.endsWith('.home.arpa') || !host.includes('.') && !net.isIP(host)) return { ok: false, why: REASON.private };
  if (net.isIP(host) && isPrivate(host)) return { ok: false, why: REASON.private };
  // The usual web ports only (example.com:25 would reach a mail server).
  if (u.port && !ports.includes(u.port)) return { ok: false, why: REASON.port };
  return { ok: true, url: u };
}

// The connection's own address lookup: every address the name resolves to must be public, and the socket connects to
// the address checked here. `resolve` and `isBlocked` are replaceable for tests only (never set by the harness).
function guardedLookup(resolve, isBlocked) {
  return (hostname, options, cb) => {
    resolve(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
      if (!list.length || list.some((a) => isBlocked(a.address))) {
        const e = new Error('private'); e.code = 'LH_PRIVATE'; return cb(e);
      }
      if (options && options.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

function getOnce(u, { resolve, isBlocked, deadline }) {
  return new Promise((resolveP) => {
    let finished = false;
    const done = (v) => { if (!finished) { finished = true; clearTimeout(timer); resolveP(v); } };
    // A total deadline, not only an idle one: a server that drips bytes slowly is cut off at 10 s.
    const timer = setTimeout(() => { try { req.destroy(); } catch {} done({ fail: REASON.timeout, retry: true }); }, Math.max(0, deadline - Date.now()));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET', agent: false, lookup: guardedLookup(resolve, isBlocked),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return done({ redirect: res.headers.location, status }); }
      // retry: true marks a failure to connect or a gateway failure, never a refusal (403, 429, a bot check), so a
      // caller can tell "try again later" from "the site said no". Only 502 and 504 count, and not when the answer
      // carries a challenge or retry-later header: a 503 is how rate limits and "checking your browser" pages turn a
      // client away.
      if (status >= 400) {
        res.resume();
        const turnedAway = Boolean(res.headers['cf-mitigated'] || res.headers['retry-after']);
        return done({ fail: status === 403 || status === 429 ? REASON.refused : REASON.status(status), status, retry: (status === 502 || status === 504) && !turnedAway });
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (!/^text\/(html|plain)\b/.test(type) && !/^application\/xhtml\+xml\b/.test(type)) { res.resume(); return done({ fail: REASON.type, status }); }
      const len = Number(res.headers['content-length'] || 0);
      if (len > MAX_BYTES) { res.destroy(); return done({ fail: REASON.too_big, status }); }
      const chunks = []; let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); done({ fail: REASON.too_big, status }); return; }
        chunks.push(c);
      });
      res.on('end', () => done({ status, type, body: Buffer.concat(chunks), bytes: size }));
      res.on('error', () => done({ fail: REASON.unreachable, status, retry: true }));
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); done({ fail: REASON.timeout, retry: true }); });
    if (Date.now() >= deadline) { req.destroy(); done({ fail: REASON.timeout, retry: true }); }
    req.on('error', (e) => done({ fail: e.code === 'LH_PRIVATE' ? REASON.private : REASON.unreachable, retry: e.code !== 'LH_PRIVATE' }));
    req.end();
  });
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', pound: '£', euro: '€', copy: '©', reg: '®', deg: '°', middot: '·' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (ENT[e.toLowerCase()] != null) return ENT[e.toLowerCase()];
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
    return m;
  });
}
// Remove each `open … close` span in one pass with indexOf (linear: an unclosed marker drops the rest of the page instead
// of making every later match scan to the end; the regex way took about a minute for 1 MB).
function dropSpans(s, isOpen, closeFor) {
  const low = s.toLowerCase(); let out = ''; let i = 0;
  for (;;) {
    const m = isOpen(low, i);
    if (!m) { out += s.slice(i); return out; }
    out += s.slice(i, m.at) + ' ';
    const end = low.indexOf(closeFor(m), m.at + 1);
    if (end < 0) return out;
    i = low.indexOf('>', end) + 1 || low.length;
  }
}
const DROP = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'head'];
const DROP_OPEN = new RegExp(`<(${DROP.join('|')})\\b`, 'g');
const MAX_HTML = 300 * 1024;   // the page text the model gets is 6,000 characters; no need to scan more than this
// Every remaining tag removed in one pass: block tags become line breaks, list items "- ", others a space. A '<' with no
// '>' after it ends the text (linear; a regex here was quadratic on pages full of unclosed tags).
const BREAK_TAGS = new Set(['br', '/p', '/div', '/li', '/tr', '/section', '/article', '/table', '/ul', '/ol', '/blockquote', 'hr',
  '/h1', '/h2', '/h3', '/h4', '/h5', '/h6']);
function stripTags(s) {
  let out = ''; let i = 0;
  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return out + s.slice(i);
    out += s.slice(i, lt);
    const gt = s.indexOf('>', lt);
    if (gt < 0) return out;
    const name = (s.slice(lt + 1, Math.min(gt, lt + 12)).match(/^\/?[a-z0-9]+/i) || [''])[0].toLowerCase();
    out += name === 'li' ? '\n- ' : BREAK_TAGS.has(name) ? '\n' : ' ';
    i = gt + 1;
  }
}
// The page as plain text: scripts, styles, forms and page furniture dropped, block tags as line breaks.
function pageText(html, type) {
  if (/^text\/plain/.test(type)) return html.slice(0, MAX_HTML).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  let s = html.slice(0, MAX_HTML);
  const lowAll = s.toLowerCase(); const ti = lowAll.indexOf('<title'); let title = null;
  if (ti >= 0) { const st = lowAll.indexOf('>', ti); const en = st < 0 ? -1 : lowAll.indexOf('</title', st); if (en > st) title = s.slice(st + 1, en); }
  s = dropSpans(s, (low, from) => { const i = low.indexOf('<!--', from); return i < 0 ? null : { at: i, tag: '!--' }; }, () => '-->');
  s = dropSpans(s, (low, from) => { DROP_OPEN.lastIndex = from; const m = DROP_OPEN.exec(low); return m ? { at: m.index, tag: m[1] } : null; },
    (m) => `</${m.tag}`);
  s = stripTags(s);
  s = decode(s).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (title ? `${decode(title).replace(/\s+/g, ' ').trim()}\n\n` : '') + s;
}

// Fetch one page. Returns { ok, url (the last address), status, bytes, text, sha, truncated } or { ok: false, why }.
async function fetchPage(raw, { resolve = dns.lookup, isBlocked = isPrivate, ports = WEB_PORTS, timeoutMs = TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  let check = checkUrl(raw, ports);
  if (!check.ok) return { ok: false, why: check.why, seconds: 0 };
  let u = check.url;
  const deadline = t0 + timeoutMs;
  for (let hop = 0; ; hop++) {
    const r = await getOnce(u, { resolve, isBlocked, deadline });
    if (r.redirect) {
      if (hop >= MAX_REDIRECTS) return { ok: false, why: REASON.redirects, seconds: (Date.now() - t0) / 1000 };
      let next; try { next = new URL(r.redirect, u); } catch { return { ok: false, why: REASON.address, seconds: (Date.now() - t0) / 1000 }; }
      check = checkUrl(next.href, ports);
      if (!check.ok) return { ok: false, why: check.why, seconds: (Date.now() - t0) / 1000 };
      u = check.url; continue;
    }
    if (r.fail) return { ok: false, why: r.fail, status: r.status || null, retryable: Boolean(r.retry), seconds: (Date.now() - t0) / 1000 };
    const body = r.body.toString('utf8');
    let text = pageText(body, r.type);
    const truncated = text.length > MAX_CHARS;
    if (truncated) text = text.slice(0, MAX_CHARS);
    return { ok: true, url: u.href, status: r.status, bytes: r.bytes, truncated, text,
      sha: crypto.createHash('sha256').update(text).digest('hex'), seconds: (Date.now() - t0) / 1000 };
  }
}

// The fetch log, <data>/fetches.jsonl: when, which chat, the address, the status, the bytes and a sha of the text the
// model got; never the page text. A held-back address keeps only a sha. Forgetting a chat deletes its lines.
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib');
const logFile = () => path.join(lib.dataDir(), 'fetches.jsonl');
function log(rec) { const r = { id: lib.newId('fetch'), ts: new Date().toISOString(), ...rec }; lib.appendJsonl(logFile(), r); return r; }
function list() { return lib.readJsonl(logFile()); }
function forget(convId) {
  const all = list(); const keep = all.filter((r) => r.conv_id !== convId);
  if (keep.length !== all.length) fs.writeFileSync(logFile(), keep.map((x) => JSON.stringify(x)).join('\n') + (keep.length ? '\n' : ''));
}

module.exports = { fetchPage, checkUrl, isPrivate, pageText, guardedLookup, REASON, MAX_CHARS, MAX_BYTES, log, list, forget };

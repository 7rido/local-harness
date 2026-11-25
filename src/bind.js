// Where the harness listens, and which Host headers it accepts.
//
//   default                      127.0.0.1 only
//   LH_HOST=<private address>    also reachable on that address: a VPN address such as Tailscale's
//                                (100.64.0.0/10 or fd7a:...) or a home network address (192.168.x.x,
//                                10.x.x.x, 172.16-31.x.x). Public addresses are refused.
//   LH_HOST=0.0.0.0              refused unless LH_ALLOW_ALL_INTERFACES=yes as well
//
// The token is still required on every request, from any address. The model server is not
// touched: it is wherever LH_MODEL_URL points, and a phone can reach only the chat page.

'use strict';

const net = require('node:net');
const os = require('node:os');

function isLoopback(ip) {
  return ip === 'localhost' || ip === '::1' || /^127\./.test(ip);
}

// Private ranges only: home networks and Tailscale's. Nothing routable on the internet.
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127); // 100.64.0.0/10: carrier-grade NAT, used by Tailscale
  }
  if (net.isIPv6(ip)) return /^f[cd][0-9a-f]{2}:/i.test(ip); // unique local, incl. Tailscale's fd7a:115c:a1e0::/48
  return false;
}

function resolveBind(env = process.env) {
  const host = String(env.LH_HOST || '127.0.0.1').trim();
  if (isLoopback(host)) return { host: host === 'localhost' ? '127.0.0.1' : host, loopback: true, all: false, warning: null };
  if (host === '0.0.0.0' || host === '::') {
    if (env.LH_ALLOW_ALL_INTERFACES !== 'yes') {
      throw new Error(`LH_HOST=${host} would listen on every network this computer is on. Use one private address instead `
        + '(your VPN or home network address), or set LH_ALLOW_ALL_INTERFACES=yes as well if you really mean it.');
    }
    return { host, loopback: false, all: true,
      warning: `listening on EVERY network interface (${host}). Anyone on any network this computer joins can reach the page; the token is the only lock.` };
  }
  if (!net.isIP(host)) throw new Error(`LH_HOST must be an IP address, got "${host}".`);
  if (!isPrivate(host)) {
    throw new Error(`LH_HOST=${host} is not a private address. The harness is never opened to the internet; `
      + 'use your VPN address (100.x.y.z) or your home network address (192.168.x.x, 10.x.x.x).');
  }
  return { host, loopback: false, all: false,
    warning: `also reachable at ${host}, not only on this computer. The token is required on every request; keep the link private.` };
}

function hostPort(ip, port) {
  return net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}

// The Host headers the server accepts (its DNS-rebinding guard): loopback always, plus the
// address it was bound to, or every interface address when bound to all of them.
// Extra Host headers (LH_ALLOWED_HOSTS, a comma list of "<private IP>:<port>"). Needed when the page is reached through a tunnel or
// port forward: the Host header passes through untouched, so a client that connects to another machine's private address arrives with
// THAT address, and this guard would answer 403. Only private (or loopback) IP literals with a port are accepted: never a public
// address, never a host name, so the guard still protects against DNS rebinding.
function extraHostHeaders(env = process.env) {
  const out = new Set(); const bad = [];
  for (const raw of String(env.LH_ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i);
    const ip = m && m[1].replace(/^\[|\]$/g, '');
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535 || !(net.isIP(ip) && (isPrivate(ip) || isLoopback(ip)))) { bad.push(raw); continue; }
    out.add(raw.toLowerCase());
  }
  if (bad.length) throw new Error(`LH_ALLOWED_HOSTS: ${bad.join(', ')} not accepted. Only private IP addresses with a port, like 100.64.1.2:7077.`);
  return out;
}

function allowedHostHeaders(bind, port, ifaces = os.networkInterfaces(), extra = new Set()) {
  const names = new Set([`127.0.0.1:${port}`, `localhost:${port}`, ...extra]);
  if (bind.all) {
    for (const list of Object.values(ifaces)) for (const i of list || []) if (!i.address.includes('%')) names.add(hostPort(i.address, port));
  } else if (!bind.loopback) {
    names.add(hostPort(bind.host, port));
  }
  return names;
}

// Links to open on this computer, and (with LH_HOST) from another device.
function pairingUrls(bind, port, token, ifaces = os.networkInterfaces()) {
  const urls = [`http://127.0.0.1:${port}/?t=${token}`];
  const extra = [];
  if (bind.all) {
    for (const list of Object.values(ifaces)) for (const i of list || []) if (!i.internal && isPrivate(i.address)) extra.push(i.address);
  } else if (!bind.loopback) {
    extra.push(bind.host);
  }
  for (const ip of extra) urls.push(`http://${hostPort(ip, port)}/?t=${token}`);
  return urls;
}

module.exports = { isLoopback, isPrivate, resolveBind, allowedHostHeaders, extraHostHeaders, pairingUrls };

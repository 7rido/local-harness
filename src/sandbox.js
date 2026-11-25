// The sealed Python runner: model-written code runs only inside a throwaway Docker container, never on the host.
//
// Protections, all on every run:
//   --rm                      the container is removed when it exits
//   --name lh-py-<random>     a name this module chose, so a stuck container can be removed by name
//   --label local-harness.sandbox=1   to find leftovers (docker ps --filter label=local-harness.sandbox)
//   --network none            no network at all
//   --read-only               the root filesystem cannot be written
//   --tmpfs /tmp:rw,size=16m  the only writable place: 16 MB of memory-backed scratch, gone with the container
//   --memory (512m)           memory cap, LH_PYTHON_MEMORY; swap is not allowed beyond it
//   --cpus 1, --pids-limit 64 one CPU, at most 64 processes (no fork bombs)
//   --cap-drop ALL, --security-opt no-new-privileges, --user 65534:65534   no capabilities, no privilege gain, not root
//   no -v / --mount           nothing of the host is mounted
//   python -E -s -I -         the code arrives on stdin; Python ignores environment variables and user site packages
// Around the container: a time limit (the container is removed by name when it is hit), a size limit on the code,
// output clipped (head and tail kept), and every argument validated, because with an ssh prefix the arguments are
// joined into a remote shell command.
//
// Fail closed: if Docker cannot be reached (no command, no daemon, a second machine that does not answer), the result is a
// failure with a message and nothing is run. There is no fallback to running the code anywhere else.
//
// Where Docker runs: LH_DOCKER is the command, default "docker". It may carry a prefix, for example
// LH_DOCKER="ssh my-server docker", which sends the same arguments and the code to another machine. The standard
// DOCKER_HOST variable (and any other Docker client setting) is passed through to the docker command unchanged.

'use strict';

const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const LABEL = 'local-harness.sandbox=1';
const MAX_CODE = 20000;
const DEFAULT_TIMEOUT_MS = 10000;
const OUTPUT_CHARS = 4000;       // what is returned (head and tail)
const OUTPUT_READ = 200000;      // what is read from the container at most

const image = () => process.env.LH_PYTHON_IMAGE || 'python:3.12-slim';
const memory = () => process.env.LH_PYTHON_MEMORY || '512m';
// Prefix and command words. Each word must be plain: no spaces, quotes or shell characters.
const dockerWords = () => String(process.env.LH_DOCKER || 'docker').trim().split(/\s+/).filter(Boolean);
const SAFE_WORD = /^[A-Za-z0-9_@./:=,+%-]+$/;

function containerName() { return `lh-py-${crypto.randomBytes(6).toString('hex')}`; }

// The arguments after the docker command. Throws on anything that is not a plain word.
function dockerArgs(name) {
  const args = ['run', '--rm', '-i', '--name', name, '--label', LABEL, '--network', 'none',
    '--memory', memory(), '--memory-swap', memory(), '--cpus', '1', '--pids-limit', '64',
    '--read-only', '--tmpfs', '/tmp:rw,size=16m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', '65534:65534', image(), 'python', '-E', '-s', '-I', '-'];
  for (const a of args) if (!SAFE_WORD.test(a)) throw new Error(`the sandbox setting ${JSON.stringify(a)} is not a plain word`);
  return args;
}

function command(extra) {
  const w = dockerWords();
  for (const a of w) if (!SAFE_WORD.test(a)) throw new Error('LH_DOCKER must be plain words, like "docker" or "ssh my-server docker"');
  return { cmd: w[0], args: [...w.slice(1), ...extra] };
}

const unavailable = (why) => ({ output: `the sandbox is not available (${why}). Nothing was run.`, ok: false, seconds: 0, unavailable: true });

function clip(s) {
  if (s.length <= OUTPUT_CHARS) return s;
  const half = Math.floor(OUTPUT_CHARS / 2);
  return `${s.slice(0, half)}\n... (output cut) ...\n${s.slice(-half)}`;
}

// Remove a container by name, whether or not it is still running. Never throws.
function kill(name) {
  try {
    const { cmd, args } = command(['rm', '-f', name]);
    const c = spawn(cmd, args, { stdio: 'ignore' });
    c.on('error', () => {});
  } catch {}
}

// Is a Docker daemon answering? (`docker info`.) Used before think harder draws tries it could not check.
function available() {
  return new Promise((resolve) => {
    let c; let done = false; const end = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} end({ ok: false, why: 'docker info did not answer in 15 seconds' }); }, 15000);
    try {
      const { cmd, args } = command(['info']);
      c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return end({ ok: false, why: String(e.message || e) }); }
    let err = '';
    c.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    c.on('error', (e) => end({ ok: false, why: e.code === 'ENOENT' ? 'the docker command was not found' : String(e.message || e) }));
    c.on('close', (code) => end(code === 0 ? { ok: true } : { ok: false, why: err.trim().split('\n').pop() || `docker info exited with ${code}` }));
  });
}

// Run code. Resolves { output, ok, seconds } and, when the sandbox itself could not run, unavailable: true.
function run(code, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    code = String(code == null ? '' : code);
    if (!code.trim()) return resolve({ output: 'no code given', ok: false, seconds: 0 });
    if (code.length > MAX_CODE) return resolve({ output: `the program is too long (over ${MAX_CODE} characters)`, ok: false, seconds: 0 });
    const t0 = Date.now();
    const secs = () => Math.round((Date.now() - t0) / 10) / 100;
    const name = containerName();
    let argv;
    try { const a = dockerArgs(name); argv = command(a); } catch (e) { return resolve(unavailable(String(e.message || e))); }
    let out = ''; let err = ''; let settled = false; let child;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      kill(name);
      try { child.kill('SIGKILL'); } catch {}
      done({ output: `timed out after ${Math.round(timeoutMs / 1000)} s`, ok: false, seconds: secs() });
    }, timeoutMs);
    try { child = spawn(argv.cmd, argv.args, { stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return done(unavailable(String(e.message || e))); }
    child.stdout.on('data', (d) => { if (out.length < OUTPUT_READ) out += d; });
    child.stderr.on('data', (d) => { if (err.length < OUTPUT_READ) err += d; });
    child.on('error', (e) => done(unavailable(e.code === 'ENOENT' ? 'the docker command was not found' : String(e.message || e))));
    child.on('close', (status) => {
      const text = (out + (err ? `${out ? '\n' : ''}${err}` : '')).trim();
      // 125, 126, 127 are docker's own failures (daemon down, command not runnable) and 255 is ssh's: the code did not run.
      if ([125, 126, 127, 255].includes(status)) return done({ ...unavailable(clip(text).split('\n').pop() || `exit status ${status}`), seconds: secs() });
      done({ output: clip(text) || '(no output)', ok: status === 0, seconds: secs() });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(code);
  });
}

module.exports = { run, available, dockerArgs, command, kill, containerName, clip, LABEL, MAX_CODE, DEFAULT_TIMEOUT_MS, OUTPUT_CHARS };

// node --test test
// The sealed Python runner (src/sandbox.js). There is no Docker daemon in the tests: LH_DOCKER points at a stub
// (test/stubs/docker) that records its arguments and stdin and prints canned output. These tests check the exact flags,
// the time limit and its cleanup call, the output clipping, and that the runner fails closed.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-sandbox-test-'));
const STUB = path.join(__dirname, 'stubs', 'docker');
const LOG = path.join(TMP, 'stub.log');

const sandbox = require('../src/sandbox');
const tools = require('../src/tools');

function env(vars) {
  for (const k of ['LH_DOCKER', 'STUB_MODE', 'STUB_OUT', 'STUB_LOG', 'LH_PYTHON_IMAGE', 'LH_PYTHON_MEMORY', 'DOCKER_HOST']) delete process.env[k];
  Object.assign(process.env, { LH_DOCKER: STUB, STUB_LOG: LOG }, vars);
  try { fs.unlinkSync(LOG); } catch {}
}
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
test.afterEach(() => env({}));

test('every protective flag is in the command line, and nothing of the host is mounted', () => {
  env({});
  const a = sandbox.dockerArgs('lh-py-test');
  const has = (...seq) => a.join(' ').includes(seq.join(' '));
  assert.strictEqual(a[0], 'run');
  for (const f of ['--rm', '-i']) assert.ok(a.includes(f), f);
  assert.ok(has('--name lh-py-test'));
  assert.ok(has('--label', sandbox.LABEL));
  assert.ok(has('--network none'));
  assert.ok(a.includes('--read-only'));
  assert.ok(has('--tmpfs /tmp:rw,size=16m'));
  assert.ok(has('--memory 512m') && has('--memory-swap 512m'));
  assert.ok(has('--cpus 1') && has('--pids-limit 64'));
  assert.ok(has('--cap-drop ALL') && has('--security-opt no-new-privileges'));
  assert.ok(has('--user 65534:65534'));
  assert.ok(has('python:3.12-slim python -E -s -I -'), 'the image, then python in isolated mode reading the code from stdin');
  assert.ok(!a.some((x) => /^(-v|--volume|--mount|--privileged|--network=host|--pid$|--pid=|--ipc|--device)/.test(x)), 'no mounts, no privileges');
  process.env.LH_PYTHON_MEMORY = '1g'; process.env.LH_PYTHON_IMAGE = 'my.registry/py:3.12';
  assert.ok(sandbox.dockerArgs('n').join(' ').includes('--memory 1g'));
  assert.ok(sandbox.dockerArgs('n').join(' ').includes('my.registry/py:3.12 python'));
});

test('the code goes to the container on stdin, and the output comes back', async () => {
  env({ STUB_OUT: '4\n' });
  const r = await sandbox.run('print(2+2)');
  assert.deepStrictEqual([r.ok, r.output], [true, '4']);
  const c = calls();
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].stdin, 'print(2+2)');
  assert.strictEqual(c[0].sub, 'run');
  assert.ok(c[0].argv.includes('--network') && c[0].argv[c[0].argv.indexOf('--network') + 1] === 'none');
  assert.ok(!c[0].argv.join(' ').includes('print(2+2)'), 'the code is never in the command line');
});

test('a failing program is a failed run with its output; no output is said so', async () => {
  env({ STUB_MODE: 'exit3' });
  const r = await sandbox.run('raise SystemExit(3)');
  assert.deepStrictEqual([r.ok, r.output, r.unavailable], [false, 'oops\nbad', undefined]);
  env({ STUB_OUT: '' });
  assert.strictEqual((await sandbox.run('pass')).output, '(no output)');
});

test('output is clipped, keeping the head and the tail', async () => {
  env({ STUB_MODE: 'big' });
  const r = await sandbox.run('print("x" * 10000)');
  assert.ok(r.output.length < sandbox.OUTPUT_CHARS + 40, String(r.output.length));
  assert.match(r.output, /\(output cut\)/);
  assert.ok(r.output.startsWith('xxxx') && r.output.endsWith('xxxx'));
});

test('the time limit ends a stuck run and removes the container by name', async () => {
  env({ STUB_MODE: 'hang' });
  const t0 = Date.now();
  const r = await sandbox.run('while True: pass', { timeoutMs: 400 });
  assert.ok(Date.now() - t0 < 5000);
  assert.deepStrictEqual([r.ok, r.output], [false, 'timed out after 0 s']);
  await new Promise((res) => setTimeout(res, 300));   // the cleanup call is made in the background
  const c = calls();
  const run = c.find((x) => x.sub === 'run');
  const name = run.argv[run.argv.indexOf('--name') + 1];
  assert.match(name, /^lh-py-[0-9a-f]{12}$/);
  const rm = c.find((x) => x.sub === 'rm');
  assert.ok(rm, 'a cleanup call was made');
  assert.deepStrictEqual(rm.argv.slice(rm.argv.indexOf('rm')), ['rm', '-f', name], 'the same container, removed by force');
});

test('code over the size limit, or empty, never reaches docker', async () => {
  env({});
  assert.match((await sandbox.run('x = 1\n'.repeat(sandbox.MAX_CODE))).output, /too long/);
  assert.strictEqual((await sandbox.run('   ')).output, 'no code given');
  assert.strictEqual(calls().length, 0);
});

test('fail closed: a daemon that cannot be reached means nothing ran, and no fallback', async () => {
  env({ STUB_MODE: 'noconnect' });
  const r = await sandbox.run('print("ran on the host?")');
  assert.deepStrictEqual([r.ok, r.unavailable], [false, true]);
  assert.match(r.output, /sandbox is not available/);
  assert.match(r.output, /Nothing was run/);
  assert.strictEqual(calls().filter((x) => x.sub === 'run').length, 1, 'one attempt, in the container command only');
  env({ LH_DOCKER: path.join(TMP, 'no-such-docker') });
  const missing = await sandbox.run('print(1)');
  assert.deepStrictEqual([missing.ok, missing.unavailable], [false, true]);
  assert.match(missing.output, /docker command was not found/);
  // Through the tool too: the same refusal, and the model is told the code did not run.
  const t = await tools.TOOLS.run_python.run({ code: 'print(1)' });
  assert.strictEqual(t.ok, false);
});

test('available() asks docker info, and says why when it cannot', async () => {
  env({});
  assert.deepStrictEqual(await sandbox.available(), { ok: true });
  assert.strictEqual(calls()[0].sub, 'info');
  env({ STUB_MODE: 'noconnect' });
  const no = await sandbox.available();
  assert.strictEqual(no.ok, false);
  assert.match(no.why, /Cannot connect/);
  env({ LH_DOCKER: path.join(TMP, 'nope') });
  assert.match((await sandbox.available()).why, /not found/);
});

test('a second machine: an LH_DOCKER prefix comes first, DOCKER_HOST is passed through', async () => {
  env({ LH_DOCKER: `${STUB} remote-box docker`, DOCKER_HOST: 'ssh://builder@remote-box' });
  const r = await sandbox.run('print(1)');
  assert.strictEqual(r.ok, true);
  const c = calls()[0];
  assert.deepStrictEqual(c.argv.slice(0, 3), ['remote-box', 'docker', 'run'], 'the prefix words, then the same docker arguments');
  assert.strictEqual(c.docker_host, 'ssh://builder@remote-box');
  assert.strictEqual(c.stdin, 'print(1)', 'the code still goes on stdin');
});

test('unsafe settings are refused rather than passed to a shell', async () => {
  env({ LH_DOCKER: 'docker; touch /tmp/pwned' });
  assert.match((await sandbox.run('print(1)')).output, /not available.*plain words/);
  env({ LH_PYTHON_IMAGE: 'python:3.12 --privileged' });
  assert.match((await sandbox.run('print(1)')).output, /not available/);
  env({ LH_PYTHON_IMAGE: 'img;id' });
  assert.strictEqual((await sandbox.run('print(1)')).unavailable, true);
  assert.strictEqual(calls().length, 0, 'docker was never started');
});

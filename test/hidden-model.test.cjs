'use strict';

/**
 * Hidden background calls on any engine (issue #85,
 * docs/designs/engine-contract-and-linux-ci.md). The memory tidy up, the
 * standing approval check, the hire check and the Work style helpers go
 * through runHiddenModel: Claude keeps its own path, Codex runs `codex exec`
 * with every tool off, and any other engine answers "unavailable" at once so
 * the caller's fallback runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { posixOnly } = require('./platform.cjs');

const args = loadTs('src/shared/hiddenModelArgs.ts');
const { runHiddenCodex } = loadTs('src/main/hiddenCodex.ts');

test('the office command picks the engine, and an explicit engine wins', () => {
  assert.equal(args.hiddenEngine('claude'), 'claude');
  assert.equal(args.hiddenEngine('/usr/local/bin/codex --profile x'), 'codex');
  assert.equal(args.hiddenEngine('gemini'), 'gemini');
  assert.equal(args.hiddenEngine(undefined), 'claude');
  assert.equal(args.hiddenEngine('claude', 'codex'), 'codex');
});

test('Claude serves every call; a custom command keeps the Claude path it had', () => {
  assert.equal(args.hiddenRunnerFor('claude', true), 'claude');
  assert.equal(args.hiddenRunnerFor('claude', false), 'claude');
  assert.equal(args.hiddenRunnerFor('custom', true), 'claude');
});

test('Codex serves only calls with every tool off', () => {
  assert.equal(args.hiddenRunnerFor('codex', true), 'codex');
  assert.equal(args.hiddenRunnerFor('codex', false), null);
});

test('every other engine has no runner, so the caller falls back at once', () => {
  for (const engine of ['gemini', 'antigravity', 'grok', 'kimi', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor']) {
    assert.equal(args.hiddenRunnerFor(engine, true), null, engine);
  }
});

test('the Codex call keeps every safety flag tested in issue #85', () => {
  const a = args.codexHiddenArgs('/tmp/work', '/tmp/answer.txt');
  assert.equal(a[0], 'exec');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--skip-git-repo-check']) assert.ok(a.includes(flag), flag);
  const pair = (flag, value) => a.some((x, i) => x === flag && a[i + 1] === value);
  assert.ok(pair('-s', 'read-only'), 'read only sandbox');
  assert.ok(pair('-C', '/tmp/work'), 'runs in the empty work folder');
  assert.ok(pair('-o', '/tmp/answer.txt'), 'answer goes to the answer file');
  assert.ok(pair('-c', 'web_search=disabled'), 'no web search');
  for (const feature of ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use']) {
    assert.ok(pair('--disable', feature), `--disable ${feature}`);
  }
  // The prompt is read from stdin, never put on the argument list.
  assert.equal(a[a.length - 1], '-');
});

/** A stand-in `codex` that records its arguments and stdin, then writes an answer. */
function fakeCodex(dir, body) {
  const file = path.join(dir, 'codex');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ argv, input, cwd: process.cwd() }));
  const out = argv[argv.indexOf('-o') + 1];
  ${body}
});
`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('a Codex call returns the answer file and passes the prompt on stdin', posixOnly('a shell script stands in for codex'), async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-codex-'));
  try {
    const exe = fakeCodex(dir, `fs.writeFileSync(out, '  FITS  \\n');`);
    const prompt = 'Does this email fit? $(rm -rf /) "quoted"';
    const r = await runHiddenCodex(prompt, { exe, timeoutMs: 10_000 });
    assert.deepEqual(r, { ok: true, text: 'FITS' });
    const seen = JSON.parse(fs.readFileSync(path.join(dir, 'seen.json'), 'utf8'));
    assert.equal(seen.input, prompt);
    assert.ok(!seen.argv.some((x) => x.includes('Does this email fit')), 'prompt never on argv');
    // It ran in an empty folder made for this call, removed afterwards.
    assert.ok(!fs.existsSync(seen.cwd), 'work folder removed after the call');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex call with no answer fails, so the caller falls back', posixOnly('a shell script stands in for codex'), async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-codex-'));
  try {
    const exe = fakeCodex(dir, `process.stderr.write('not signed in'); process.exit(1);`);
    const r = await runHiddenCodex('hello', { exe, timeoutMs: 10_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /not signed in/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex call that runs too long is stopped', posixOnly('a shell script stands in for codex'), async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-codex-'));
  try {
    const exe = fakeCodex(dir, `setTimeout(() => fs.writeFileSync(out, 'late'), 60_000);`);
    const r = await runHiddenCodex('hello', { exe, timeoutMs: 300 });
    assert.deepEqual(r, { ok: false, error: 'hidden session timed out' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a cancelled Codex call answers cancelled', posixOnly('a shell script stands in for codex'), async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-codex-'));
  try {
    const exe = fakeCodex(dir, `setTimeout(() => fs.writeFileSync(out, 'late'), 60_000);`);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const r = await runHiddenCodex('hello', { exe, timeoutMs: 10_000, signal: stop.signal });
    assert.deepEqual(r, { ok: false, error: 'cancelled' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty prompt never starts Codex', async () => {
  const r = await runHiddenCodex('   ', { exe: '/nonexistent/codex', timeoutMs: 1_000 });
  assert.deepEqual(r, { ok: false, error: 'empty prompt' });
});

// The callers: on an engine with no runner each one takes its own fallback,
// and Claude is never started with another engine's command.
const ptyPath = require.resolve('node-pty');
require.cache[ptyPath] = { id: ptyPath, filename: ptyPath, loaded: true, exports: { spawn() { throw new Error('no pty in tests'); } } };
const HC = loadTs('src/main/hiddenClaude.ts');
const { standingFitCheck } = loadTs('src/main/standingCheck.ts');
const { checkDistinct } = loadTs('src/main/hireCheck.ts');

/** Count Claude calls while `fn` runs. */
async function claudeCalls(fn) {
  const real = HC.runHiddenClaude;
  const calls = [];
  HC.runHiddenClaude = async (prompt, opts) => { calls.push(opts); return { ok: true, text: 'FITS' }; };
  try { return { result: await fn(), calls }; } finally { HC.runHiddenClaude = real; }
}

test('on a Claude office the standing check still runs on Claude, with the same options', async () => {
  const { result, calls } = await claudeCalls(() => standingFitCheck({ cwd: () => '/tmp', command: () => 'claude' })('reply', { to: ['a@b.c'], subject: 's', body: 'b' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'claude');
  assert.equal(calls[0].noTools, true);
  assert.equal('engine' in calls[0], false, 'no engine option reaches runHiddenClaude');
  assert.notEqual(result, undefined);
});

test('on a Gemini office the standing check falls back to Ask me without starting anything', async () => {
  const log = [];
  const { result, calls } = await claudeCalls(() => standingFitCheck({ cwd: () => '/tmp', command: () => 'gemini', log: (e) => log.push(e) })('reply', { to: ['a@b.c'], subject: 's', body: 'b' }));
  assert.equal(calls.length, 0, 'Claude is never started with the gemini command');
  assert.equal(result, null, 'no verdict, so the email goes to the owner');
  assert.deepEqual(log, [{ kind: 'standing-check-unread', reason: 'unavailable' }]);
});

test('on a Gemini office the hire check uses its rules verdict', async () => {
  const pam = { name: 'Pam', title: 'Executive Admin', routing: 'Pam sorts the business inbox.' };
  const ryan = { name: 'Ryan', title: 'Marketing', routing: 'Ryan writes the social posts.' };
  const { result, calls } = await claudeCalls(() => checkDistinct(ryan, [pam], { cwd: '/tmp', command: 'gemini' }));
  assert.equal(calls.length, 0);
  assert.equal(result.source, 'rules');
});

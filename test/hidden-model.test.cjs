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
const { runHiddenCodex, codexLaunch } = loadTs('src/main/hiddenCodex.ts');

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
  // Value: protects=a check that reads an owner's email or agents' notes can never run a shell, browse or reach apps; fails_when=a flag is dropped or the prompt moves onto argv; why_new=new Codex runner; seam=none
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
    // Value: protects=the owner's private email never reaches the office log agents read; fails_when=codex output is copied into the error; why_new=found in review pass 2; seam=fake codex
    // Codex repeats the prompt in its progress output; a failure must not
    // carry it into the error, which callers write to the office log.
    const exe = fakeCodex(dir, `process.stderr.write('user: ' + input + '\\nnot signed in'); process.exit(1);`);
    const r = await runHiddenCodex('PRIVATE EMAIL BODY', { exe, timeoutMs: 10_000 });
    assert.deepEqual(r, { ok: false, error: 'no answer from codex (exit 1)' });
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

test('a stopped Codex call ends everything it started', posixOnly('POSIX process groups'), async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-codex-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  try {
    // Value: protects=a timed out or cancelled check stops spending the owner's quota; fails_when=only the launcher is killed and its child keeps the model call running; why_new=found in review pass 2; seam=fake codex
    // Like the npm launcher: codex starts the real binary as its own child.
    const exe = fakeCodex(dir, `const g = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
  setTimeout(() => fs.writeFileSync(out, 'late'), 60_000);`);
    // Stop only once the child exists, however slow the machine is; a timeout
    // and a cancel take the same stop path.
    const stop = new AbortController();
    const watch = setInterval(() => { if (fs.existsSync(pidFile)) stop.abort(); }, 20);
    const r = await runHiddenCodex('hello', { exe, timeoutMs: 30_000, signal: stop.signal });
    clearInterval(watch);
    assert.deepEqual(r, { ok: false, error: 'cancelled' });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 50)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the child codex started is killed too');
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

test('on Windows the npm codex launcher runs through cmd.exe with paths with spaces kept whole', () => {
  // Value: protects=a Windows owner whose user name has a space still gets Codex checks; fails_when=the work folder or answer file splits at the space; why_new=the first version passed /c with Node's own quoting; seam=none
  const exe = 'C:\\Users\\Jai D\\AppData\\Roaming\\npm\\codex.cmd';
  const work = 'C:\\Users\\Jai D\\AppData\\Local\\Temp\\dbm-hidden-codex-1\\work';
  const l = codexLaunch('win32', exe, args.codexHiddenArgs(work, 'C:\\Users\\Jai D\\x\\answer.txt'), 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(l.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(l.windowsVerbatimArguments, true);
  assert.equal(l.args.length, 1);
  assert.ok(l.args[0].startsWith('/d /s /c "'), l.args[0]);
  assert.ok(l.args[0].includes(`"${exe}"`), 'launcher path quoted whole');
  assert.ok(l.args[0].includes(`-C "${work}"`), 'work folder quoted whole');
});

test('a real codex.exe and every other platform start directly with an argument array', () => {
  const a = ['exec', '-'];
  assert.deepEqual(codexLaunch('win32', 'C:\\tools\\codex.exe', a), { file: 'C:\\tools\\codex.exe', args: a });
  assert.deepEqual(codexLaunch('linux', '/usr/local/bin/codex', a), { file: '/usr/local/bin/codex', args: a });
  assert.deepEqual(codexLaunch('darwin', '/opt/homebrew/bin/codex', a), { file: '/opt/homebrew/bin/codex', args: a });
});

test('no temp folder means a failed call, never a thrown one', posixOnly('TMPDIR steers os.tmpdir() on POSIX'), async () => {
  // Value: protects=a full disk or blocked temp folder sends the email to Ask me instead of crashing the check; fails_when=mkdtemp throws out of the promise; why_new=found in review pass 3; seam=TMPDIR
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = path.join(os.tmpdir(), 'does-not-exist-' + process.pid);
  try {
    const r = await runHiddenCodex('hello', { exe: '/nonexistent/codex', timeoutMs: 1_000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
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
  assert.deepEqual(result, { fits: true });
});

test('on a Gemini office the standing check falls back to Ask me without starting anything', async () => {
  // Value: protects=an email under a standing approval on an engine with no runner goes to the owner; fails_when=Claude's flags are sent to another CLI or the check answers yes; why_new=issue #85; seam=runHiddenClaude stubbed
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

'use strict';

/**
 * The typed isolation capability on each engine preset (issue #139; TODOS.md,
 * "Make a second engine (Codex first) ready for an office", gap 9).
 *
 * test/engine-readiness.test.cjs checks that an engine's preset can start an
 * office member. This checks the folder privacy half: BUILD_ENGINES admits an
 * engine only once its preset proves an OS sandbox plus the app's deny rules,
 * so adding Codex or Gemini there fails here first, with the reason named.
 *
 * It pins what each preset claims. What the app writes for Claude is pinned by
 * test/office-privacy-conformance.test.cjs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const ap = loadTs('src/shared/agentProvider.ts');
const KINDS = ['os-sandbox', 'pretooluse-only', 'none'];

/** '' when an engine with this isolation may be offered, else why not. */
function gapOf(id, kind, platform) {
  return kind === 'os-sandbox' ? '' : `${id} proves ${kind} folder isolation on ${platform}, needs os-sandbox`;
}
const isolationGap = (id, platform) => gapOf(id, ap.engineIsolation(id, platform), platform);

test('every engine preset declares one of the three isolation kinds', () => {
  for (const p of ap.AGENT_PROVIDER_PRESETS) {
    assert.ok(KINDS.includes(p.isolation), `${p.id} has isolation ${p.isolation}`);
  }
});

test('every engine this build offers proves an OS sandbox on macOS and Linux', () => {
  // Value: protects=no engine reaches owners while another member's folder is readable from it; fails_when=an id joins BUILD_ENGINES before its preset proves os-sandbox; why_new=issue #139; seam=none
  for (const id of ap.BUILD_ENGINES) {
    for (const platform of ['darwin', 'linux']) assert.equal(isolationGap(id, platform), '');
  }
});

test('Codex and Gemini are not yet admitted, and the gate says why', () => {
  // Value: protects=the presets record today's code, not plans; fails_when=a preset claims a sandbox before the change that builds it (#48); why_new=issue #139; seam=none
  assert.equal(isolationGap('codex', 'darwin'), 'codex proves none folder isolation on darwin, needs os-sandbox');
  assert.equal(isolationGap('gemini', 'linux'), 'gemini proves none folder isolation on linux, needs os-sandbox');
});

test('only Claude claims an OS sandbox today', () => {
  const sandboxed = ap.AGENT_PROVIDER_PRESETS.filter((p) => p.isolation === 'os-sandbox').map((p) => p.id);
  assert.deepEqual(sandboxed, ['claude']);
});

test('on Windows an OS sandbox counts as a PreToolUse check only', () => {
  // Value: protects=the Windows build never claims shell commands are held to the folder rules; fails_when=engineIsolation reports os-sandbox on win32; why_new=Claude Code has no sandbox on Windows (office-privacy-conformance); seam=none
  assert.equal(ap.engineIsolation('claude', 'win32'), 'pretooluse-only');
  assert.equal(ap.engineIsolation('claude', 'darwin'), 'os-sandbox');
  assert.equal(ap.engineIsolation('codex', 'win32'), 'none');
});

test('the gate refuses a PreToolUse check only and admits an OS sandbox', () => {
  assert.equal(gapOf('codex', 'pretooluse-only', 'linux'), 'codex proves pretooluse-only folder isolation on linux, needs os-sandbox');
  assert.equal(gapOf('codex', 'none', 'linux'), 'codex proves none folder isolation on linux, needs os-sandbox');
  assert.equal(gapOf('codex', 'os-sandbox', 'linux'), '');
});

'use strict';

/**
 * The capability half of an engine's readiness (issues #48, #139;
 * docs/designs/engine-contract-and-linux-ci.md). test/engine-readiness.test.cjs
 * checks that an engine's preset can start an office member; this checks that
 * the app can keep its promises there, and that the capability table matches
 * the code.
 *
 * Adding an engine to BUILD_ENGINES fails here first, with the missing pieces
 * named, until its row is true and proved.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const ap = loadTs('src/shared/agentProvider.ts');
const caps = loadTs('src/shared/engineCapabilities.ts');
const hidden = loadTs('src/shared/hiddenModelArgs.ts');

const ALL = ap.AGENT_PROVIDER_PRESETS.map((p) => p.id);

test('every engine has a capability row', () => {
  assert.deepEqual(Object.keys(caps.ENGINE_CAPABILITIES).sort(), [...ALL].sort());
});

test('every engine this build offers can keep folders private, run background checks and reach the mail tools', () => {
  // Value: protects=no engine reaches owners while a member's folder, background checks or mail would silently break on it; fails_when=an id is added to BUILD_ENGINES before its row is true; why_new=issue #139; seam=none
  for (const id of ap.BUILD_ENGINES) {
    assert.deepEqual(caps.officeGaps(id), [], `${id} is in BUILD_ENGINES but the app cannot keep its promises there`);
  }
});

test('Codex is not yet ready to be offered, and the gaps say why', () => {
  assert.deepEqual(caps.officeGaps('codex'), [
    'folder privacy is none, needs os-sandbox',
    "the app's MCP servers (mail) do not reach it"
  ]);
});

test('Gemini is not yet ready to be offered, and the gaps say why', () => {
  assert.deepEqual(caps.officeGaps('gemini'), [
    'folder privacy is none, needs os-sandbox',
    'no runner for background checks',
    "the app's MCP servers (mail) do not reach it"
  ]);
});

test('the hiddenRunner column matches the runners runHiddenModel really has', () => {
  // Value: protects=the table cannot claim a runner the code lacks, or hide one it has; fails_when=hiddenRunnerFor and ENGINE_CAPABILITIES drift; why_new=new table; seam=none
  for (const id of ALL) {
    if (id === 'custom') continue; // its own test below
    const hasRunner = hidden.hiddenRunnerFor(id, true) !== null;
    assert.equal(caps.ENGINE_CAPABILITIES[id].hiddenRunner, hasRunner, `${id}: table says ${caps.ENGINE_CAPABILITIES[id].hiddenRunner}, code says ${hasRunner}`);
  }
});

test('a custom command keeps the Claude path but the table promises nothing for it', () => {
  // A custom command is usually a wrapper around claude, so its background
  // calls keep the path they always had; but the app cannot tell what it
  // really runs, so it is never counted ready to be offered.
  assert.equal(hidden.hiddenRunnerFor('custom', true), 'claude');
  assert.deepEqual(caps.ENGINE_CAPABILITIES.custom, { isolation: 'none', hiddenRunner: false, appMcpServers: false });
  assert.equal(caps.officeGaps('custom').length, 3);
});

test('only Claude claims an OS sandbox and the app MCP servers today', () => {
  const sandboxed = ALL.filter((id) => caps.ENGINE_CAPABILITIES[id].isolation === 'os-sandbox');
  const withMcp = ALL.filter((id) => caps.ENGINE_CAPABILITIES[id].appMcpServers);
  assert.deepEqual(sandboxed, ['claude']);
  assert.deepEqual(withMcp, ['claude']);
});

test('the gate refuses an engine that has every capability but folder privacy', () => {
  const table = { ...caps.ENGINE_CAPABILITIES, codex: { isolation: 'pretooluse-only', hiddenRunner: true, appMcpServers: true } };
  assert.deepEqual(caps.officeGaps('codex', table), ['folder privacy is pretooluse-only, needs os-sandbox']);
  assert.deepEqual(caps.officeGaps('codex', { ...table, codex: { ...table.codex, isolation: 'os-sandbox' } }), []);
});

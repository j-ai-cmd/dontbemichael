# Engine contract, hidden calls on any engine, and Linux CI

Date: 2026-10-15. Branch: `feat/engine-contract-linux-ci`.

## Why

The office runs only on Claude Code today. The goal is to support other engines
(Codex first, then Gemini) and more operating systems (Linux). `TODOS.md` already
lists the gaps under "Make a second engine (Codex first) ready for an office".
This change closes three of them without adding any engine to `BUILD_ENGINES`:

1. **Hidden calls run only on Claude (issue #85, gap 6).** The memory tidy up,
   the standing approval check, the hire check and the three Work style helpers
   all call `runHiddenClaude`, which builds Claude arguments. On a Codex office
   each one fails; the worst is the standing approval check, so every email
   under a standing approval falls back to Ask me.
2. **No typed record of what each engine can enforce (issue #139, gap 9).**
   Whether an engine can keep a member's folder private, run a hidden check or
   take the app's MCP servers lives only in prose. A conformance test cannot
   refuse an engine that has not proved it.
3. **Linux has a build target but no CI.** `electron-builder.yml` builds an
   AppImage, but CI runs only on macOS and Windows, so nothing checks that the
   app's tests pass on Linux.

## What changes

### 1. `runHiddenModel` (src/main/hiddenModel.ts)

One entry point for every background call: `runHiddenModel(prompt, opts)`.

- The engine comes from `opts.engine`, else from the office command
  (`inferAgentProvider(opts.command)`, the same rule the rest of the app uses).
- **Claude** keeps the current path unchanged: the call goes to
  `runHiddenClaude` with the same options.
- **Codex** runs `codex exec` with the flags tested in issue #85 (every tool
  off, read only sandbox, an empty folder, no user config, answer written to a
  file). The prompt goes in on stdin, so no prompt text is ever a shell
  argument.
- **Any other engine** answers `{ ok: false, error: 'unavailable' }` at once,
  and each caller's existing fallback runs (the rules verdict, Ask me, the
  plain text rewrite, a skipped tidy up).
- The Codex runner serves only `noTools` calls. A call that needs tools on a
  non-Claude engine is answered as unavailable, never run with tools on.
- Codex's progress output repeats the prompt (an owner's email, a member's
  notes), and callers write a failed call's error to the office log. So that
  output is never kept: an error names only the exit code.
- The npm `codex` is a launcher that starts the native binary as its own
  child. On a timeout or cancel the whole process tree is killed
  (`hardKillTree`: its process group on POSIX, `taskkill /T` on Windows), so no
  model call keeps running after the app gave up on it.

The argument list is built by a pure function in `src/shared/hiddenModelArgs.ts`
so the tests can check it without spawning anything.

The trust check in `index.ts` (Pete's privacy guard) stays on `runHiddenClaude`
on purpose: its comment says it is "Always Claude, whatever engine the office
runs on". This change does not touch it.

### 2. Engine capabilities (src/shared/engineCapabilities.ts)

A typed table, one row per `AgentProvider`, so TypeScript fails when a new
engine is added without a row:

| Field | Meaning |
|---|---|
| `isolation` | `os-sandbox` (OS sandbox plus deny rules), `pretooluse-only` (a hook check only), or `none` (the app enforces no folder privacy) |
| `hiddenRunner` | `runHiddenModel` can serve this engine's background calls |
| `appMcpServers` | the app's MCP servers (md-mail and the rest) reach this engine |

Values record today's code, not hopes: Claude is `os-sandbox` with a runner
and MCP servers; Codex has a runner after this change but no folder privacy and
no app MCP servers yet (#48, #109); every other engine has none of them.

### 3. Conformance test (test/engine-conformance.test.cjs)

- Every engine in `BUILD_ENGINES` must have `isolation: 'os-sandbox'`, a hidden
  runner and the app's MCP servers. Adding Codex to `BUILD_ENGINES` today fails
  here first, with the missing pieces named.
- The capability table agrees with the code: an engine marked `hiddenRunner`
  really gets a runner from `hiddenRunnerFor`, and one not marked does not.
- Codex's hidden call arguments keep every safety flag from issue #85, and the
  prompt is never on the argument list.

It sits beside `test/engine-readiness.test.cjs` (the preset half) and does not
change it.

### 4. Linux CI (.github/workflows/ci.yml)

A `test-linux` job on `ubuntu-latest`, the same steps as `test-macos`. Like
every job, a red one fails the run, so a Linux failure is visible on every pull
request. Making it a required check is a setting in the "protect main" ruleset,
which the owner changes.

## What does not change

- `BUILD_ENGINES` stays `['claude']`. Nothing new is offered to owners.
- The trust check stays Claude only.
- No release workflow change: Linux releases need the owner's decision.
- Claude behaviour of every hidden call is identical: same function, same
  options.

## Plan and checks

| # | Task | Check (must exit 0) |
|---|---|---|
| T1 | Baseline test run before any change | `npm run test:focused` (record failures, if any) |
| T2 | `hiddenModelArgs.ts`, `hiddenModel.ts` and their test | `node --test test/hidden-model.test.cjs` |
| T3 | Switch the six background callers to `runHiddenModel` | no `runHiddenClaude` left in the four caller files, and T2's test passes |
| T4 | `engineCapabilities.ts` and the conformance test | `node --test test/engine-conformance.test.cjs test/engine-readiness.test.cjs` |
| T5 | Linux CI job | `ci.yml` parses and has a `test-linux` job on `ubuntu-latest` |
| T6 | No regression | `npm run typecheck && npm run test:focused` |
| T7 | No contradiction with the repo's own rules | `BUILD_ENGINES` is still `['claude']`; the trust check still calls `runHiddenClaude` |
| T8 | Pushed to the fork, CI green on all five jobs | `gh pr checks` on the fork's pull request |

## Follow ups this enables (not in this change)

- Codex app MCP servers through `CODEX_HOME/config.toml` (#109), then flip
  `appMcpServers` for Codex.
- Folder privacy for Codex (#48), then raise its `isolation`.
- A Gemini hidden runner and usage reader (#113).
- Only then: add `'codex'` to `BUILD_ENGINES`; the conformance test is the gate.

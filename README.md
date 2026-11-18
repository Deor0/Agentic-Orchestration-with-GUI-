# orchestrator

A Windows-first desktop GUI for running several AI coding agents (Claude Code, Codex CLI, Gemini CLI, …) in parallel on git worktrees.

This is a personal daily-driver tool, not a product. No installer, no code signing, no auth, no multi-user, no telemetry. It serves a plain browser UI from `127.0.0.1`.

**Current reality: features 1–3 of 7 are built.** What exists today is one correct PTY-backed terminal pane in a browser, a process-tree killer that actually works on Windows, and an in-band agent-state parser. The screen that makes the tool worth using — the inbox — is not built. Read the [status table](#status) before assuming anything else works.

---

## Why this exists

Every GUI orchestrator in this space is Mac-first:

| Tool | Windows situation |
|---|---|
| Conductor | "Run parallel coding agents **on your Mac**" — macOS only |
| Calyx, Perch | Apple Silicon only |
| Firstmate | macOS/Linux; ~96 unowned Windows issues |
| Claude Squad | Windows binary fails on session create since April 2026 — Go's `creack/pty` has no Windows support |
| Orca | Ships a Windows build; the worktree path hangs, rejects backslashes, and hits "Filename too long" |

In the main community index of these tools, macOS mentions outnumber Windows roughly 2:1, the macOS-only entries are disproportionately the polished native apps, and exactly one tool in the whole index is described as Windows-native — and it isn't a coding orchestrator. Stack Overflow's 2025 survey put Windows at 49.5% of professional developers against macOS at 32.9% (2025 figure; a 2026 breakdown was not found).

The gap is specifically Windows **plumbing**, and it is not a porting detail:

- tmux does not exist here;
- ConPTY is nothing like a Unix PTY — it forwards terminal queries instead of answering them, silently drops early resizes, and starts children in the OEM code page;
- MAX_PATH and junction semantics break `git worktree` in ways Mac-first authors never hit.

None of that is visible from a Mac, which is why the Mac-first tools ship Windows builds that fail at session create.

---

## The thesis

**The attention inbox is the product. The terminal multiplexer is commodity.**

Tabs, panes and kanban boards are decoration. The screen that earns its keep sorts agents by *what they need from you*:

```
Needs you   — blocked on permission / question / auth, oldest first
Failed      — non-zero exit, or wedged
Working     — running; you do not need to look
```

…with inline Allow/Deny on the row and one hotkey that jumps to the **longest-waiting** agent. Everything in features 1–3 exists only to feed that screen: the pane gives you a real PTY, the job object makes "kill this agent" mean it, and the OSC 7501 parser is where "Needs you" comes from.

### The bottleneck is human review, not agent throughput

Simon Willison: *"the natural bottleneck on all of this is how fast I can review the results."* Reported telemetry (provisional — treat as directional) shows median review time up sharply against modest throughput gains.

The design consequence is concrete: **cap concurrency at what you can actually review, and serve the longest-waiting agent first.** This tool is not trying to maximise the number of agents running. Ten agents all blocked on you is worse than three you can keep up with.

### Built on generic CLI processes and plain git, deliberately

This category churns hard. In 2026 alone: Conductor acquired by Meta (the local Mac app supported only "until early 2027"); HumanLayer/CodeLayer acquired by Factory; Vibe Kanban sunset when Bloop shut down; Crystal deprecated; Claudia dormant since Aug 2025; Claude Squad in maintenance. Tools in this space die by acqui-hire, by having no business model, or by a solo maintainer running out of time.

So the only things this depends on are **agent CLIs that speak stdin/stdout** and **plain git**. There is no vendor API, no cloud service, no account. Nothing here can be switched off by someone else.

---

## Design principles

Each of these is a filed bug or a standing complaint in a shipping competitor. They are stated as commitments, and most are not implemented yet — see the status table.

| Principle | Why |
|---|---|
| Agent state comes from hooks and in-band protocol, **never** terminal scraping as the primary source. A quiet-PTY timer may only ever report `stale`, never `blocked`. | A timer cannot tell "waiting for you" from "thinking slowly". A false "needs you" is worse than no signal at all. |
| Busy state has exactly **one** owner, and records are bound to a per-incarnation token. | A superseded agent's late events must be rejected, not applied to its replacement. |
| **Never** auto-restart, signal or interrupt a live agent. Surface → defer → escalate → finally mark it wedged. | Automated recovery on a half-finished agent destroys work. |
| **Approve is never offered on a truncated request.** If the full request isn't on screen, the approve affordance is absent. | One-click approving text you cannot see is how an agent gets permission you never granted. |
| Allow-rules must never auto-answer a **question** or a **plan**. | A rule for "allow `npm test`" is not consent to a design decision. |
| Cost is attributed **per task and per branch**, never one global meter. A per-task ceiling pauses and raises an inbox item; it does not kill the agent. | An invisible runaway review loop is the known way these setups get expensive. A global meter tells you money is gone, not which agent is burning it. |
| **Never merge inside the agent's own worktree.** Preview → apply, two steps, with a staleness guard on both sides. | Merging under a live agent corrupts its working state; a stale preview applies a diff you never reviewed. |

---

## Status

Feature contract and per-behaviour detail live in [`SPEC.md`](SPEC.md). This table mirrors it.

| # | Feature | Status | What is actually there |
|---|---|---|---|
| 1 | **Terminal pane** | ✅ Landed | `src/shell.mjs`, `src/pane.mjs`. PTY-backed shell with correct UTF-8, resize, Ctrl-C, exit codes, capped 2 MB scrollback. Shell discovery for PowerShell 7 / Windows PowerShell / Git Bash, absolute paths only. |
| 2 | **Process-tree kill** | ✅ Landed | `src/jobkill.mjs`. Win32 Job Object with `KILL_ON_JOB_CLOSE` via koffi. Kills grandchildren whose parent already exited — `taskkill /T` does not. |
| 3 | **Agent state detection** | ⚠️ Parser only | `src/osc7501.mjs` is complete and wired into `Pane` (`pane.status`, `pane.onStatus()`). That is **tier 1 of 4**. Hooks, screen-scraping and exit-code tiers are not built, and nothing renders the state. |
| 4 | **The inbox** | 📋 Planned | Nothing. No SQLite, no board, no Allow/Deny, no toasts, no hotkey. This is the feature that makes the tool worth using daily and it does not exist. |
| 5 | **Worktrees** | 📋 Planned | Nothing. No git code at all. The twelve Windows rules (W1–W12) in `SPEC.md` are research, not implementation. |
| 6 | **Diff and merge-back** | 📋 Planned | Nothing. |
| 7 | **Cost attribution** | 📋 Planned | Nothing. |

Tests: **32** across four files — 15 parser, 9 pane, 4 job-kill, 4 integration. The parser tests are pure and fast; the other 17 spawn real PTYs and real process trees, which makes them slow (~25 s) and timing-sensitive. `interrupt() stops a running command` in particular can flake when the whole suite runs four PTY files at once; it passes reliably on `node --test --test-force-exit test/pane.test.mjs` alone. Re-run a single file before believing a failure.

To be explicit about what "features 1–3" buys you right now: the UI is **a single terminal in a browser tab** with a shell dropdown and a Ctrl-C button. It does not yet orchestrate anything.

---

## Quick start

Requires **Node 24+** on Windows. No compiler, no Rust, no Python, no admin.

```sh
npm install
npm run dev          # -> http://127.0.0.1:7777
npm test             # 32 tests
```

`npm run dev` prints the URL and the shells it found. Set `PORT` to move it off 7777. These are the only two scripts in `package.json`; there is no build step and nothing to compile.

`test/e2e.mjs` is a manual smoke check against an already-running server — it is **not** part of `npm test` (which globs `test/*.test.mjs`). Run it with `node test/e2e.mjs` while `npm run dev` is up.

---

## Architecture

```
browser (public/index.html, public/app.mjs)
   xterm.js, bytes in / bytes out — the server owns UTF-8 boundaries
        |  WebSocket  (binary = PTY bytes, JSON = input/resize/interrupt/ready/exit)
        |  HTTP       (/ , /app.mjs , /vendor/* from node_modules , /api/shells)
        v
src/server.mjs      node:http + ws. One Pane per WebSocket connection.
        |
        v
src/pane.mjs        the whole Windows PTY problem in one class:
        |             - answers DA1 / CPR itself so the shell starts headless
        |             - re-applies size for 5 s after spawn (ConPTY drops early resizes)
        |             - cumulative buffer capped at 2 MB, overflow counted in `dropped`
        |             - drops xterm.js's duplicate query replies on the way in
        |
        +-- src/shell.mjs     shell discovery; absolute paths only; UTF-8 init
        +-- src/jobkill.mjs   Job Object per pane, handle held in this process
        +-- src/osc7501.mjs   pure parser: bytes in, status events out
```

Deliberately missing: no framework, no bundler, no transpile, no state container. xterm and its fit addon are served straight out of `node_modules` as ES modules.

An Electron wrapper is a later, optional ~40 lines. Nothing in the design needs it.

---

## No compile step, ever

The target machine has no Rust toolchain and no MSVC `cl.exe`. Every dependency choice follows from that one constraint:

| Chosen | Rejected | Reason |
|---|---|---|
| `@lydell/node-pty` | upstream `node-pty` | Upstream's install script falls through to `node-gyp rebuild` when no prebuild matches. |
| `koffi` | a native addon for Win32 | koffi ships a prebuilt `.node` per platform as an optional dependency. Verified on this machine: installing it never invokes node-gyp, cmake or a compiler, and it works with npm install scripts blocked entirely. |
| `node:sqlite` | `better-sqlite3` | Built in to Node 24. (Not used yet — it arrives with feature 4.) |
| Node 24 + browser UI | Tauri | Tauri needs Rust. |

Current dependency list, in full: `@lydell/node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `koffi`, `ws`. No dev dependencies — tests are `node:test` and `node:assert/strict`.

---

## Windows gotchas

These each cost real debugging time and none of them are findable by reading the docs.

| Symptom | Cause |
|---|---|
| A pane spawns and sits there dead, no prompt, no output at all. | Bundled ConPTY **forwards** DA1 (`ESC[c`) and CPR (`ESC[6n`) to the terminal instead of answering them, and the shell emits **nothing** until it gets a reply. `Pane` answers both itself, so it works headless with no browser attached. If this regresses, everything looks broken at once. |
| `onData` hands you a string when you asked for bytes. | On Windows node-pty hard-sets the conout socket to utf8 and **ignores its own `encoding` option**. Re-encode with `Buffer.from(chunk, 'utf8')` — `'binary'` flattens every character above U+00FF. |
| A resize issued right after spawn does nothing. | ConPTY silently drops a resize before the child attaches. `Pane` re-applies the wanted size on every chunk for the first 5 s. |
| `pty.pid` is `0`. | It is, for the first ~100 ms — ConPTY fills it in on `ready_datapipe`. Pass the **terminal object** to `superviseTree()`, never `pty.pid`. It polls. |
| `npm test` "hangs" and never exits. | Missing `--test-force-exit`. node-pty keeps libuv handles open so the runner never exits on its own. The script in `package.json` already has the flag; anything you run by hand needs it too. |
| Non-ASCII agent output is mojibake. | A ConPTY child starts in the **OEM code page** (measured: IBM437). The PowerShell shells are launched with a `-NoExit -Command` UTF-8 init so the fix never shows up in scrollback. |
| `bash.exe` starts the wrong thing or fails with "File not found". | Three different binaries answer to `bash.exe` on a typical PATH: Git's, the System32 WSL shim, and the WindowsApps alias. Shells resolve to absolute paths only. |
| A test asserting on exact terminal text flakes. | PSReadLine redraws the input line character by character, so the raw buffer contains many partial echoes before the real output. Poll the cumulative buffer for a substring with a timeout. |

Two more, for when features 5–6 land: send Enter as `\r`, never `\n` or `\r\n` (a blank CRLF line killed Claude Code's stream-json input until v2.1.208), and `.cmd` shims cannot be `execFile`'d — `claude`, `codex` and `gemini` from npm are all `.cmd`.

---

## The one behaviour change that surprises people

**Quitting the orchestrator kills every running agent tree.**

Each pane's Job Object handle is held in the orchestrator process. When that process exits — cleanly, on crash, or killed from Task Manager — Windows closes the handle and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates every process still in the job, orphans included.

This is intentional: it is the same mechanism that makes "kill this agent" actually reach `powershell.exe → claude.cmd → node.exe → git.exe` when the middle links have already exited. The cost is that **you cannot leave agents running by closing the app**. `JOB_OBJECT_LIMIT_BREAKAWAY_OK` is deliberately not set, so there is no opt-out.

---

## Known limitations

**Not built** — features 4–7. There is no inbox, no persistence, no worktree management, no diff or merge-back, no cost tracking. Each pane is one shell in one browser tab.

**Pane lifetime is tied to the browser.** Closing the tab disposes the pane and kills its process tree. Panes must outlive the viewer before this is a real daily driver; that arrives with feature 4 (sessions in `node:sqlite`).

**Agent state is detected but not displayed.** `pane.status` and `pane.onStatus()` work; nothing in the UI reads them.

**Only the top tier of state detection exists.** OSC 7501 means the agent self-reports — Claude Code ships it since v2.1.295. An agent that does not speak it reports nothing at all. Hooks, scraping and exit-code tiers are planned.

**Record-store semantics are out of scope for the parser.** `app` inheritance down the id tree, `clear` cascade, and lifetime rules (dropping `working`/`blocked` on exit or OSC 133 `A`) belong to the pane/inbox wiring and are not implemented. Decoded base64 is not validated as well-formed UTF-8 — invalid bytes become U+FFFD rather than rejecting the report. A report sent with no terminator is dropped at the first newline, which is correct per spec but means a buggy agent shows *no* status rather than an error.

**Git Bash may leak a few short-lived profile helpers.** `bash -i -l` forks profile helpers far earlier than PowerShell's CLR startup, so some can land outside the job before it is assigned. They are short-lived, and the agent CLI started later is always inside the job. ⚠️ **This is reasoning, not measurement.** For PowerShell the margin is measured and comfortable: pid assignable at 90/89/111 ms, earliest a ConPTY PowerShell could itself spawn at 964/900/908 ms.

**Other kill escapes**, all inherent to Windows:
- Elevated or cross-user children escape the job — UAC is brokered by the AppInfo service, so the new process is not a child. Same for `ShellExecute` handoffs to `explorer.exe`, scheduled tasks and services.
- If job assignment fails, the code falls back to `taskkill /F /T`, which leaks orphaned grandchildren. `mode` from `src/jobkill.mjs` reports which path is live, and a test asserts it is `'job'`. Note that `mode` reflects whether koffi loaded, not whether every assignment succeeded.
- PID reuse: if a shell exits on its own and its pid is recycled before `dispose()`, the job closed is the old empty one. Narrow.

**Windows only.** `jobkill.mjs` degrades to the taskkill path off Windows, and shell discovery looks in `Program Files` and `System32`. There is no macOS or Linux story and there is not meant to be one.

**No security boundary.** The server binds `127.0.0.1` and has no auth. Any process on the machine can connect to the WebSocket and get a shell with your privileges. Do not bind it to a routable address.

**`@xterm/addon-webgl` is declared but unused** — the UI currently loads only xterm and the fit addon.

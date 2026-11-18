# Feature spec — Windows-first agent orchestrator

Contract for each feature: module paths, API surface, and the behaviours that must hold.
Written so a test-writing agent can work from this alone, without reading the implementation.

**Status key** — read this before writing tests for a section:

| Mark | Meaning |
|---|---|
| ✅ **LANDED** | Implemented and verified. Write tests freely. |
| 🚧 **IN FLIGHT** | Being built right now by another agent. API below is the brief, not yet reality — tests may need adjusting when it lands. |
| 📋 **PLANNED** | Not built. Do not write tests yet unless asked; they will all fail. |

---

## 0. Conventions that apply to every test

These are not optional — tests written without them will hang or flake.

- **ESM, `node:test`, `node:assert/strict`.** No test framework dependency.
- **Always run with `--test-force-exit`.** `node --test --test-force-exit "test/*.test.mjs"`. node-pty keeps libuv handles open, so the runner never exits on its own. A test run that "hangs" is almost always this.
- **A PTY pane needs ~1800 ms before it will accept input.** The shell has to start and complete the ConPTY handshake. Writing earlier silently does nothing.
- **Never assert on an exact terminal string.** PSReadLine redraws the line character-by-character as input arrives, so the raw buffer contains many partial echoes of the command before the real output. Always poll the *cumulative* buffer for a substring, with a timeout.
- **Always `dispose()` a pane**, in a `finally`. A leaked pane is a leaked process tree.
- **Send Enter as `\r`, never `\n`**, and never `\r\n` — see rule W5.
- Scratch files belong in the system temp dir, never the repo.

Standard helpers (copy into test files; there is deliberately no shared test util yet):

```js
const wait = ms => new Promise(r => setTimeout(r, ms));

/** Poll the pane's cumulative buffer until pred matches, or time out. */
async function until(pane, pred, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred(pane.buffer.toString('utf8'))) return true;
    await wait(100);
  }
  return false;
}
```

---

## 1. Terminal pane ✅ LANDED

One PTY-backed shell that behaves correctly on Windows. Everything else sits on top of this.

### `src/shell.mjs`

```js
export const SHELLS            // { [id]: { label, candidates: string[], args: string[] } }
export function defaultShellId(): string | null   // first installed, preference order
export function resolveShell(id): string | null   // absolute path, or null if not installed
export function available(): Array<{ id, label, path }>  // installed shells only
```

Shell ids: `pwsh` (PowerShell 7), `powershell` (Windows PowerShell 5.1), `gitbash`.

**Must hold:**
- `resolveShell()` returns an **absolute** path (`/^[A-Za-z]:\\/`) or `null`. Never a bare name.
- `available()` excludes shells that are not on disk. On a machine without PowerShell 7, `pwsh` must not appear.
- `defaultShellId()` prefers `pwsh` → `powershell` → `gitbash`.
- Git Bash resolves to Git's own `bash.exe`, **not** `C:\Windows\System32\bash.exe` (the WSL shim) and not the WindowsApps alias. This is rule W8 and it is a real, filed bug class in other tools.

### `src/pane.mjs`

```js
new Pane({ shellId?, cwd?, cols = 80, rows = 24 })   // throws if shell not installed

pane.id          // uuid
pane.shellId
pane.cwd
pane.buffer      // Buffer, cumulative output, capped (see below)
pane.dropped     // bytes discarded from the front of buffer
pane.exit        // null until exit, then { exitCode, signal }

pane.write(data)         // input from a viewer
pane.interrupt()         // Ctrl-C
pane.resize(cols, rows)
pane.subscribe(fn)       // fn(bytes, exit) -> returns unsubscribe()
pane.dispose()
```

**Must hold:**

| # | Behaviour | Why it exists |
|---|---|---|
| 1.1 | Constructing with an unknown `shellId` throws `/shell not installed/`. | |
| 1.2 | The shell reaches a prompt unaided. | Bundled ConPTY **forwards** DA1 (`ESC[c`) and CPR (`ESC[6n`) to the terminal instead of answering them, and the shell produces **no output at all** until answered. The pane answers them itself so it works headless, with no browser attached. This is the single highest-value behaviour here — if it regresses, everything looks dead. |
| 1.3 | A command runs and its output appears in `buffer`. | |
| 1.4 | `interrupt()` cancels a running command and the shell stays usable afterwards. | Must be `\x03` through the PTY. `GenerateConsoleCtrlEvent` cannot target a process group — it returns success and delivers nothing. |
| 1.5 | `write()` **drops** a client-sent DA1 reply (`ESC[?1;2c`). | xterm.js answers DA1 on its own; the server already did. Without this the shell gets two replies. Assert `buffer.length` is unchanged. |
| 1.6 | `resize()` called **before the shell is up** still takes effect. | ConPTY silently drops a resize issued before the child attaches, and the first output is ConPTY's own handshake, not the shell. Re-applied across a warmup window. Test by resizing immediately after construction, then asking the shell its width. |
| 1.7 | `resize()` after startup takes effect. | |
| 1.8 | Exit code propagates to `pane.exit` and to `subscribe` listeners. | `exit 7` must yield `exitCode === 7`. |
| 1.9 | Non-ASCII output survives round trip. | ConPTY children start in the **OEM code page** (measured: `IBM437`), which mangles agent output. Test with box-drawing `U+2500 U+2502` and accented `U+00E9` — what agent TUIs actually emit. **Astral-plane emoji (U+1F680) are out of scope**: the Windows PowerShell 5.1 console cannot render them regardless of encoding, so asserting on them measures conhost, not us. PowerShell gotcha: `[char]0x2500 + [char]0x2502` is *numeric addition*; use `"$([char]0x2500)$([char]0x2502)"`. |
| 1.10 | `buffer` is capped at 2 MB; older bytes are dropped from the front and counted in `dropped`. | Backpressure: an agent can dump a 100 MB log. |
| 1.11 | `dispose()` is idempotent and safe on an already-exited pane. | |

---

## 2. Process-tree kill ✅ LANDED

### `src/jobkill.mjs`

Real process shape is `powershell.exe → claude.cmd → node.exe → git.exe`. `pty.kill()` leaks grandchildren; `taskkill /T` walks the *parent* chain and misses processes whose parent already exited — the normal case.

A real Win32 Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (Cargo's fix, rust-lang/cargo#2370), reached from Node via `koffi` (prebuilt binary, no node-gyp). The handle is held **in the orchestrator process**, so `killTree()` is one `CloseHandle` and Windows terminates every surviving member, orphans included. `BREAKAWAY_OK` is deliberately not set.

```js
export const mode                      // 'job' | 'taskkill' (fallback)
export function superviseTree(terminal) // -> { kill() }; pass the pty, NOT pty.pid
export function killTree(target)
```

`superviseTree` takes the terminal object because **`pty.pid` is `0` for the first ~100 ms** — ConPTY only fills it in on `ready_datapipe`. It polls for it.

**Must hold:**
- Killing a 3-deep tree where the **middle process has already exited** still kills the grandchild. A test that only kills a direct child proves nothing.
- `mode === 'job'`. If it is `'taskkill'`, grandchildren leak — assert on this.
- Poll the grandchild's PID until gone; death is not synchronous.
- Safe on an already-dead PID; must not kill the orchestrator or unrelated processes.
- Keep the **control test**: the same tree killed with `taskkill /F /T` must still leak the orphan. If that ever starts passing, Windows changed and this module is no longer needed.

**Known leak cases** — real, measured where stated:
1. **Spawn race, ~100 ms.** node-pty owns `CreateProcess`, so spawn-suspended isn't available. Measured: pid assignable at 90/89/111 ms; earliest a ConPTY PowerShell can itself spawn was 964/900/908 ms — ~800 ms margin. Safe for PowerShell.
2. **Git Bash is the weak spot.** `bash -i -l` forks profile helpers far earlier than PowerShell's CLR startup, so some may land outside the job. Short-lived, and the agent CLI started later is always inside. ⚠️ **Reasoning, not measured.**
3. **Elevated / cross-user children escape** — UAC is brokered by the AppInfo service, so the new process is not a child. Same for `ShellExecute` handoffs to `explorer.exe`, scheduled tasks and services.
4. Assign failure → taskkill fallback → leaks.
5. **PID reuse:** if a shell exits on its own and its pid is recycled before `dispose()`, `killTree(pid)` closes the old empty job. Narrow.

**Behaviour change this introduces:** when the orchestrator exits *for any reason*, the OS closes its job handles and **every supervised agent tree dies with it**. Desirable here — no leaked agent CLIs after a crash — but it is new, and it means you cannot leave agents running by closing the app.

---

## 3. Agent state detection ✅ LANDED (OSC 7501 tier) / 📋 PLANNED (hook + scrape tiers)

The core of the product: for each agent, is it *working*, *blocked on me*, *done*, or *stuck*.

### `src/osc7501.mjs` ✅

OSC 7501 "Program Status Protocol", rev 0.4 (2026-10-10) — agents report their own state in-band. Claude Code ships it since v2.1.295. Pure logic: bytes in, events out, no I/O, no timers.
Authoritative spec: <https://www.superlogical.com/rex/docs/build/program-status> (verified against directly — Hashimoto's post is only a summary).

```js
import { Osc7501Parser, PROBE_REPLY, STATUSES } from './osc7501.mjs';
const parser = new Osc7501Parser();
const events = parser.feed(bytes);   // Buffer | Uint8Array | string -> event[]
```

Events:
- `{ type:'status', status, confidence:'reported', id, app, progress, title, msg }` — absent fields are `null`.
- `{ type:'clear', id }` — `id: null` means clear every record.
- `{ type:'probe', reply: PROBE_REPLY }` — write `reply` back to the PTY. That is the whole responder.

**The normalized enum every tier maps onto:**

```
working | blocked | blocked:permission | blocked:question | blocked:auth | done | error | idle
```

> **Corrected after verifying the spec.** An earlier draft of this document listed `blocked:plan` and omitted `blocked:auth`. **OSC 7501 has exactly three kinds — `permission`, `question`, `auth` — and no `plan`.** A plan-approval state can therefore only ever come from a *scraping* tier (Claude Code plan mode), never at `confidence: 'reported'`. Bare `blocked` is also legal when a program reports no kind or an unknown one; the UI needs a fallback for it. `clear` is **not a state** — it is an action that removes the addressed record and all its descendants.

Every event carries `confidence`. This module always emits `'reported'` — the highest trust tier.

**Must hold:**
- **Sequences split across chunk boundaries parse correctly.** A PTY delivers arbitrary fragments. Covered: splits at *every* byte offset of a full report, byte-at-a-time feeding, mid-`7501`, mid-base64, and mid-multi-byte-character.
- Ordinary output and unrelated CSI / OSC 0 / OSC 133 sequences interleaved with status reports corrupt neither.
- **An ESC that isn't ST, or any other C0/DEL byte, cancels an in-flight report.** Without this a truncated report swallows the next real one into its body.
- Over-length sequences are dropped and scanning resumes, so an agent spewing megabytes without a terminator cannot grow the buffer. Whole sequence ≤4096 B; `msg` ≤2732 encoded / 2048 decoded; `title` 256/192; `app` 32; `id` 128 total, 32 per segment, 8 deep; key 16.
- Spec-dictated failure granularity: bad base64 or a control char in decoded text **discards the whole report**; a single malformed pair **skips only that pair**; a missing/unknown `state` or invalid `id` ignores the report; unknown keys are ignored.
- Both `ESC \` (ST) and `BEL` are valid terminators.
- The capability probe round-trips.

**Known limits** (deliberate, documented by the implementer): record storage, `app` inheritance down the `id` tree, `clear` cascade, and lifetime rules (dropping `working`/`blocked` on exit or OSC 133 `A`) are **record-store concerns and not implemented here** — they belong to the pane/inbox wiring. Decoded base64 is not validated as well-formed UTF-8; invalid bytes become U+FFFD rather than rejecting the report. A report sent with no terminator is dropped at the first newline — correct per spec, but it means a buggy agent shows *no* status rather than an error.

### Tiers below OSC 7501 📋 PLANNED

Not built. Design for reference so tests aren't written against the wrong model:

| Tier | Source | `confidence` |
|---|---|---|
| 1 | OSC 7501 | `reported` |
| 2 | Agent hooks (Claude Code posts to a local HTTP endpoint) | `reported` |
| 3 | Screen scraping: alt-screen `?1049h`, bottom-lines regex on the **rendered buffer**, cursor position | `inferred` |
| 4 | Exit code | `reported` (only unambiguous "done") |

Two invariants that must survive into tests later:
- **A quiet-PTY timer may only ever produce `stale`, never `blocked`.** It cannot distinguish "waiting for you" from "thinking slowly", and a false "needs you" is worse than no signal.
- **Busy state has exactly one owner, and records are bound to a per-incarnation token**, so a superseded agent's late events are rejected.

---

## 4. The inbox ✅ LANDED (toast click-focus needs a manual check)

The screen that makes N agents tractable. Not the terminal layout — the queue.

Planned surface: sessions persisted in `node:sqlite`; a board bucketing agents into **Needs you / Failed / Working**; inline Allow/Deny on the row; one hotkey that jumps to the **longest-waiting** agent; Windows toasts.

Behaviours to test when built:
- Bucketing is **derived from agent state**, never set manually.
- "Jump to longest-waiting" picks by time-blocked, not by list order.
- **Approve is never offered on a truncated request** — if the full request isn't shown, the approve affordance must be absent.
- Unanswered requests resolve to an explicit, documented outcome — never silently hang.
- A queued follow-up prompt is never consumed as the answer to a permission prompt.
- Panes outlive the browser; reconnecting replays history.

---

## 5. Worktrees 📋 PLANNED

Git worktree per task, Windows-correct. Every rule below is a filed bug in a shipping competitor.

| # | Rule |
|---|---|
| W1 | `git -c core.longpaths=true` on **every** invocation. Per-command, no admin. The registry `LongPathsEnabled` does **not** cover Git. Keep roots short (`C:\wt\<slug>`). |
| W2 | 🔴 **Never create a junction inside a worktree.** `git worktree remove --force` follows junctions and recursively deletes the far side — this has emptied a main checkout's `node_modules`. |
| W3 | Removal order: kill tree → stop watchers → **rename aside on same volume** → `git worktree prune` → delete in background, tolerating failure. Windows refuses to delete a directory that is any live process's CWD, and `git worktree remove` drops its bookkeeping *before* deleting, stranding directories invisible to `git worktree list`. |
| W4 | `* text=auto eol=lf` in `.gitattributes`; never trust `core.autocrlf`. |
| W5 | Never write `\r\n` to an agent's stdin. A blank CRLF line killed Claude Code's stream-json input until v2.1.208. |
| W6 | Treat the PTY as bytes; decode UTF-8 with a streaming decoder. |
| W7 | Ctrl-C is `\x03` through the PTY. |
| W8 | Resolve shells to absolute paths. |
| W9 | `.cmd` shims can't be `execFile`'d — `claude`/`codex`/`gemini` from npm are `.cmd`. |
| W10 | Serialize git mutations per repo through one queue — N worktrees still contend on shared `.git` and `index.lock`. |
| W11 | `git worktree add` checks out **tracked files only** — `.env` and gitignored files don't come along. |
| W12 | Warn on two tracked paths differing only in case; they cannot coexist on a case-insensitive FS. |

**Gate:** 20 create/remove cycles against a throwaway repo with an agent holding each worktree as CWD; zero stranded directories; `git worktree list` matches disk.

---

## 6. Diff and merge-back 📋 PLANNED

- Merge / rebase / squash each as **preview → apply**, two distinct steps.
- `--no-ff` default, so the agent's commits survive.
- **Staleness guard:** refuse to apply if *either* side changed since the preview was generated.
- Merge happens in a **separate integration worktree**, never the agent's own.
- Conflicts stay in the checkout — never auto-abort.
- Offer "hand this conflict back to the agent that owns the branch", with the conflicted files attached.
- Inline review comments batch into **one** prompt back to the agent.

## 7. Cost attribution 📋 PLANNED

- Parse agent session JSONL; roll up **per task and per branch**, never a single global meter — an invisible runaway review loop is the known failure mode.
- Label figures an **estimate at list prices**, not a bill. On a subscription, in-plan usage isn't billed per token at all — present "tokens consumed".
- A per-task ceiling **pauses and raises an inbox item**; it does not kill the agent.

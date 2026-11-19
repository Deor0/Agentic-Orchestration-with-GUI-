# Where we stopped — 2026-11-19

Resume point for "The Cult", a Windows-first orchestrator for parallel AI coding agents.
Read `SPEC.md` for the feature contract and `README.md` for the why.

## State

| # | Feature | State |
|---|---|---|
| 1 | Terminal pane | ✅ done |
| 2 | Process-tree kill | ✅ done |
| 3 | Agent state detection | ⚠️ OSC 7501 tier done; **hook + scraping tiers not built** |
| 4 | The inbox | ✅ done |
| 5 | Worktrees (pens) | ✅ done |
| 6 | **Diff and merge-back** | 📋 **not started — pick up here** |
| 7 | Cost attribution | 📋 not started |

**Suite: 112/112 green.** `ORCH_NO_TOASTS=1 node --test --test-force-exit "test/*.test.mjs"` (~2 min; the 20-cycle worktree gate alone is 23s).

## What the tool does today

`npm run dev` → `127.0.0.1:7777`. Choose a repo ("the ground"), press `+` to raise a lamb: it gets its own git worktree on a `cult/lamb-N` branch, with a shell running inside it. The board sorts lambs by what they need from you; `Ctrl+J` jumps to the longest-waiting. A blocked agent raises a Windows toast. Culling a lamb kills its whole process tree and removes the pen.

## Pick up here: feature 6, diff and merge-back

Nothing written. `SPEC.md` §6 has the contract. The shape:
- Merge / rebase / squash, each as **preview → apply**, two distinct steps.
- `--no-ff` default so the agent's commits survive.
- **Staleness guard**: refuse to apply if *either* side changed since the preview.
- Merge in a **separate integration worktree**, never the agent's own pen.
- Conflicts stay in the checkout — never auto-abort.
- "Hand this conflict back to the lamb that owns the branch", with the conflicted files attached.
- Inline review comments batch into **one** prompt back to the agent.

`src/git.mjs` already has the primitives worth reusing: a single `git()` helper that applies `core.longpaths` and `GIT_TERMINAL_PROMPT=0` to every call, a per-repo mutation queue, and `createPen`/`removePen` for the integration worktree.

## Decisions made (don't relitigate)

- **Every lamb gets its own auto-named pen** (`cult/lamb-N`), created before the shell starts.
- **One repo per session**, chosen via the sidebar picker, held in memory.
- **Pens survive quitting.** Killing the orchestrator kills agent trees but leaves pens on disk — the work is in them. Only an explicit cull removes a pen; `sweep()` reclaims strays.
- **SQLite dropped from feature 4**, moved to feature 7. Job Object handles live in the orchestrator, so agent trees die on restart regardless.
- **Theme is labels-only.** The `BUCKETS` map at the top of `public/app.mjs` is the whole vocabulary; `src/` keeps literal names.
- **No compile step, ever.** No Rust, no MSVC here. Hence `@lydell/node-pty`, `koffi`, `node:sqlite`, `node-notifier` — and no Tauri.
- **Origin-checked, no token.** WebSockets ignore same-origin, so every WS handshake and `/api/` call checks `Origin`. A missing `Origin` is allowed: browsers always send it, so its absence means a non-browser client that already has local code execution.

## Gotchas that cost real time

- Tests **must** use `--test-force-exit` — node-pty holds the event loop open. A "hanging" run is almost always this.
- A PTY pane needs **~1800 ms** before it accepts input.
- **Never assert exact terminal strings.** PSReadLine redraws character-by-character and emits an SGR reset immediately before output, so `/\b123\b/` can never match. Use a delimited marker like `COLS=123`.
- Writing JS via a bash heredoc **mangles backslashes** (`\7` → octal escape, `C:\Users\x` → invalid `\x`). Use Write/Edit for JS files.
- `[char]0x2500 + [char]0x2502` is **numeric addition** in PowerShell, not string concat.
- Bundled ConPTY **forwards DA1 to the terminal and the shell emits nothing until answered**. A pane that spawns and sits dead is this.
- `node-pty` on Windows ignores its own `encoding` option and hands you an **already-decoded string**.

## Unverified / owed — needs your eyes, not mine

- **Nobody has looked at the redesigned UI.** Confirm `✦ † ❧ ☉ ☽` render as monochrome glyphs, not colour emoji or tofu.
- **Toast click-routing through the server is untested.** `node src/notify.mjs` raises one real toast — click it and a pane id should print.
- Toast app name and icon are SnoreToast defaults; unseen.
- `snoretoast-x64.exe` is unsigned: Smart App Control or AV quarantine silently disables toasts (no crash, no notifications).
- Feature 3's missing tiers mean any agent not speaking OSC 7501 shows as `working/inferred` forever — the inbox is only fully useful with Claude Code.
- **The whole app has never been driven by hand** end to end with a real `claude` session in a pen.

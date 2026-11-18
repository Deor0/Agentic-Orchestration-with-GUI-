import * as pty from '@lydell/node-pty';
import { randomUUID } from 'node:crypto';
import { resolveShell, SHELLS, defaultShellId } from './shell.mjs';
import { superviseTree } from './jobkill.mjs';
import { Osc7501Parser } from './osc7501.mjs';

const ESC = '\u001b';

// Bundled ConPTY (useConptyDll) forwards terminal queries to the *terminal*
// instead of answering them itself. Nothing in the shell runs until it gets a
// reply, so the server must answer even with no browser attached.
const QUERY_REPLIES = [
  { q: `${ESC}[c`, a: `${ESC}[?1;2c` },   // DA1  -> VT100 with AVO
  { q: `${ESC}[6n`, a: `${ESC}[1;1R` },   // CPR  -> cursor at 1,1
];

// Replies the browser's xterm.js generates on its own. The server is
// authoritative, so these are dropped to avoid answering twice.
const CLIENT_AUTOREPLY = new Set(QUERY_REPLIES.map(r => r.a));

const WARMUP_MS = 5000;            // window in which ConPTY may still drop a resize
const MAX_SCROLLBACK = 2 * 1024 * 1024; // bytes; drop-with-marker beyond this

export class Pane {
  constructor({ shellId = defaultShellId(), cwd = process.cwd(), cols = 80, rows = 24 } = {}) {
    const file = resolveShell(shellId);
    if (!file) throw new Error(`shell not installed: ${shellId}`);

    this.id = randomUUID();
    this.shellId = shellId;
    this.cwd = cwd;
    this.listeners = new Set();
    this.statusListeners = new Set();
    this.buffer = Buffer.alloc(0);
    this.dropped = 0;
    this.exit = null;
    this.size = { cols, rows };
    this.spawnedAt = Date.now();
    this.lastOutputAt = null;   // drives the inbox's staleness heuristic

    // Agent state, highest-trust tier. Null until the agent reports anything;
    // the scraping tiers that fill the gap are not built yet.
    this.parser = new Osc7501Parser();
    this.status = null;
    this.statusAt = null;

    this.pty = pty.spawn(file, SHELLS[shellId].args, {
      name: 'xterm-256color',
      cols, rows, cwd,
      env: process.env,
      useConptyDll: true,
    });

    // Hold the job handle in this process: handle lifetime == orchestrator
    // lifetime, so a crash takes the agent trees with it instead of leaking
    // them. Takes the terminal, not the pid - pty.pid is 0 for the first ~100ms.
    this.job = superviseTree(this.pty);

    this.pty.onData(chunk => {
      // Rule 6: treat the PTY as bytes - but node-pty hard-sets the conout
      // socket to utf8 on Windows (its `encoding` option is ignored there), so
      // chunk is already decoded; 'binary' flattened every char above U+00FF.
      const bytes = Buffer.from(chunk, 'utf8');
      this.lastOutputAt = Date.now();
      this.#answerQueries(bytes);
      this.#readStatus(bytes);
      this.#reapplySize();
      this.#append(bytes);
      for (const fn of this.listeners) fn(bytes);
    });

    this.pty.onExit(e => {
      this.exit = e;
      for (const fn of this.listeners) fn(null, e);
    });
  }

  // ConPTY silently drops a resize issued before the child is attached, and the
  // first output is ConPTY's own handshake rather than the shell. Re-apply the
  // wanted size on each chunk for the first few seconds until it sticks.
  #reapplySize() {
    if (Date.now() - this.spawnedAt > WARMUP_MS) return;
    try { this.pty.resize(this.size.cols, this.size.rows); } catch { /* gone */ }
  }

  #answerQueries(bytes) {
    const s = bytes.toString('latin1');
    for (const { q, a } of QUERY_REPLIES) if (s.includes(q)) this.pty.write(a);
  }

  /** OSC 7501: the agent reports its own state. We are the terminal, so we also
   *  have to answer its capability probe or it will assume we support nothing. */
  #readStatus(bytes) {
    for (const ev of this.parser.feed(bytes)) {
      if (ev.type === 'probe') this.pty.write(ev.reply);
      else if (ev.type === 'status') {
        this.status = ev;
        this.statusAt = Date.now();
      } else if (ev.type === 'clear' && (ev.id === null || ev.id === this.status?.id)) {
        this.status = null;
        this.statusAt = null;
      }
      for (const fn of this.statusListeners) fn(ev);
    }
  }

  #append(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > MAX_SCROLLBACK) {
      const cut = this.buffer.length - MAX_SCROLLBACK;
      this.buffer = this.buffer.subarray(cut);
      this.dropped += cut;
    }
  }

  /** Input from a viewer. Drops xterm.js's own query replies. */
  write(data) {
    if (CLIENT_AUTOREPLY.has(data)) return;
    this.pty.write(data);
  }

  /** Rule 7: Ctrl-C is \x03 through the PTY. GenerateConsoleCtrlEvent cannot
   *  target a process group, so this is the only thing that works. */
  interrupt() { this.pty.write('\u0003'); }

  resize(cols, rows) {
    this.size = { cols, rows };
    try { this.pty.resize(cols, rows); } catch { /* pane already gone */ }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Agent state changes: fn(event) for every OSC 7501 status/clear. */
  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  dispose() {
    // Close the job first: that is what reaches grandchildren whose parent has
    // already exited. pty.kill() alone leaves them running.
    try { this.job?.kill(); } catch { /* never assigned */ }
    try { this.pty.kill(); } catch { /* already exited */ }
    this.listeners.clear();
    this.statusListeners.clear();
  }
}

import { Pane } from './pane.mjs';

/**
 * Owns the live panes. The point of this layer is lifetime: a pane belongs to
 * the registry, not to whichever browser socket happens to be watching it, so
 * closing a tab no longer kills the agent running in it.
 *
 * Deliberately in-memory. Persisting sessions across an orchestrator restart is
 * impossible while the Job Object handles live in this process - the agent trees
 * die with us regardless - so a database here would buy nothing.
 */
export class PaneRegistry {
  constructor() {
    this.panes = new Map();
    this.watchers = new Set();
  }

  /** `pen` is opaque here: {path, branch} if the lamb got a worktree. The
   *  registry does no git - the server owns that, so this stays testable. */
  create({ shellId, cwd, title, cols, rows, pen = null } = {}) {
    const pane = new Pane({ shellId, cwd, cols, rows });
    pane.pen = pen;
    // Display string, not an identifier - the themed UI reads rows as "Lamb · x".
    const label = pen?.branch?.replace(/^cult\//, '') ?? pane.cwd.split(/[\\/]/).pop();
    pane.title = title ?? `Lamb · ${label}`;
    this.panes.set(pane.id, pane);

    // Any state change is worth telling the UI about: these are exactly the
    // moments a pane can enter or leave the attention queue.
    pane.onStatus(() => this.#changed('status'));
    pane.subscribe((_bytes, exit) => { if (exit) this.#changed('exit'); });

    this.#changed('roster');
    return pane;
  }

  get(id) { return this.panes.get(id); }

  /** Plain descriptors for inbox.summarize() - no Pane objects leak out. */
  describe() {
    return [...this.panes.values()].map(p => ({
      id: p.id,
      title: p.title,
      shellId: p.shellId,
      cwd: p.cwd,
      status: p.status?.status ?? null,
      // The parser already decoded these; without them the board can say
      // "blocked:permission" but never *what* permission, which makes an
      // inline Allow impossible and leaves the toast body a bare enum.
      detail: p.status ? { msg: p.status.msg, kind: p.status.kind ?? null, app: p.status.app } : null,
      statusAt: p.statusAt,
      lastOutputAt: p.lastOutputAt,
      exit: p.exit,
      pen: p.pen,
    }));
  }

  close(id) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    pane.dispose();
    this.panes.delete(id);
    this.#changed('roster');
    return true;
  }

  /** Subscribe to "something about the fleet changed". `fn(reason)`, where
   *  reason is 'roster' (a pane was added or forgotten), 'exit' (a shell ended
   *  by itself), 'status' (an agent reported), 'touch' or 'shutdown'. A watcher
   *  that does real work needs the distinction: 'status' fires on every OSC
   *  7501 report, potentially many per second; the rest are rare. */
  watch(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Tell watchers the fleet moved for a reason the registry cannot see
   *  (e.g. an abandoned pen was culled). */
  touch() { this.#changed('touch'); }

  #changed(reason) {
    for (const fn of this.watchers) {
      try { fn(reason); } catch { /* a bad watcher must not take the fleet down */ }
    }
  }

  disposeAll() {
    for (const pane of this.panes.values()) pane.dispose();
    this.panes.clear();
    this.#changed('shutdown');
  }
}

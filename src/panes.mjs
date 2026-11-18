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

  create({ shellId, cwd, title, cols, rows } = {}) {
    const pane = new Pane({ shellId, cwd, cols, rows });
    pane.title = title ?? `${pane.shellId} — ${pane.cwd.split(/[\\/]/).pop()}`;
    this.panes.set(pane.id, pane);

    // Any state change is worth telling the UI about: these are exactly the
    // moments a pane can enter or leave the attention queue.
    pane.onStatus(() => this.#changed());
    pane.subscribe((_bytes, exit) => { if (exit) this.#changed(); });

    this.#changed();
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
      statusAt: p.statusAt,
      lastOutputAt: p.lastOutputAt,
      exit: p.exit,
    }));
  }

  close(id) {
    const pane = this.panes.get(id);
    if (!pane) return false;
    pane.dispose();
    this.panes.delete(id);
    this.#changed();
    return true;
  }

  /** Subscribe to "something about the fleet changed". */
  watch(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  #changed() {
    for (const fn of this.watchers) {
      try { fn(); } catch { /* a bad watcher must not take the fleet down */ }
    }
  }

  disposeAll() {
    for (const pane of this.panes.values()) pane.dispose();
    this.panes.clear();
    this.#changed();
  }
}

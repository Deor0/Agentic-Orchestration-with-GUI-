// The inbox: pane descriptors in, attention queue out.
// Pure. No I/O, no timers, no Pane import; `now` is injected so it is deterministic.

/** Buckets in the order the UI renders them. `order` follows this order too. */
export const BUCKETS = ['needsYou', 'failed', 'working', 'done', 'idle'];

const DEFAULT_STALE_MS = 5 * 60_000;

/**
 * @param {Array<{id, title, status, statusAt, lastOutputAt, exit}>} panes
 * @param {number} now ms
 * @param {{staleMs?: number}} [opts]
 * @returns {{buckets: Record<string, object[]>, order: object[], counts: Record<string, number>}}
 */
export function summarize(panes, now, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;

  const buckets = Object.fromEntries(BUCKETS.map(b => [b, []]));
  for (const pane of panes ?? []) {
    const r = row(pane, now, staleMs);
    buckets[r.bucket].push(r);
  }

  // Longest-waiting first. Array#sort is stable, so equal waits keep input order.
  buckets.needsYou.sort((a, b) => b.waitingMs - a.waitingMs);

  return {
    buckets,
    order: BUCKETS.flatMap(b => buckets[b]),
    counts: Object.fromEntries(BUCKETS.map(b => [b, buckets[b].length])),
  };
}

function row(pane, now, staleMs) {
  const bucket = classify(pane);
  const r = {
    id: pane.id,
    title: pane.title,
    bucket,
    status: pane.status ?? null,
    exitCode: pane.exit ? pane.exit.exitCode : null,
    confidence: pane.exit || pane.status ? 'reported' : 'inferred',
    stale: bucket === 'working' && isStale(pane, now, staleMs),
  };
  // waitingMs is for blocked rows only. statusAt can be null (a status with no
  // timestamp), and `now - null` is 0, not NaN - but be explicit about it.
  if (bucket === 'needsYou') {
    r.waitingMs = pane.statusAt == null ? 0 : Math.max(0, now - pane.statusAt);
  }
  return r;
}

function classify(pane) {
  if (pane.exit) return pane.exit.exitCode === 0 ? 'done' : 'failed';   // exit is authoritative
  if (pane.status === 'error') return 'failed';
  // Only a *reported* blocked status may claim your attention. A pane that has
  // merely gone quiet is `stale` and stays in `working`: a quiet-PTY timer
  // cannot tell "waiting for you" from "thinking slowly", and a false "needs
  // you" is worse than no signal. This omission is deliberate - see SPEC §3.
  if (pane.status?.startsWith('blocked')) return 'needsYou';
  if (pane.status === 'done') return 'done';
  if (pane.status === 'idle') return 'idle';
  return 'working';   // reported `working`, or never reported: assume working, flagged inferred
}

function isStale(pane, now, staleMs) {
  return pane.lastOutputAt == null || now - pane.lastOutputAt > staleMs;
}

// Windows toasts for agents that are blocked and waiting. One click brings the
// user back to the pane that raised it.
//
// Transport is SnoreToast, shipped prebuilt inside node-notifier: no node-gyp,
// no install script, so this machine's blocked-install-scripts policy does not
// bite it. `wait: true` keeps one SnoreToast child alive per toast; that child
// is the only channel Windows gives a non-packaged app for click-back.
//
// Everything here is best-effort. A missing toast is annoying; a throw inside
// the orchestrator loses work. Nothing in this file may throw or reject.

import process from 'node:process';

let backend = null;
try {
  if (process.platform === 'win32' && process.env.ORCH_NO_TOASTS !== '1') {
    backend = (await import('node-notifier')).default;
  }
} catch { /* not installed: `available` goes false and notify() is a no-op */ }

/** False when toasts cannot work here. notify() is then a silent no-op. */
export const available = backend !== null;

const BURST_MS = 1200;       // collect a simultaneous wave of blocks into one toast
const MIN_GAP_MS = 10_000;   // floor between toasts, however many agents block
const TOAST_SECONDS = 20;    // how long SnoreToast waits before reporting timedout
const MAX = { title: 64, body: 180 };   // past roughly this, Windows elides the text itself

/** @param {object} [opts] test seam: inject a transport and shrink the timers. */
export function createNotifier({
  transport = available ? snoreToast : null,
  burstMs = BURST_MS,
  minGapMs = MIN_GAP_MS,
} = {}) {
  const pending = new Map();   // pane id -> {title, body}; insertion order = blocked order
  const listeners = new Set();
  let timer = null;
  let lastShownAt = -Infinity;

  /** Queue a toast for a blocked pane. Returns false if it was dropped. */
  function notify(options) {
    const { title, body, id } = options ?? {};
    if (!transport) return false;
    const paneId = typeof id === 'string' ? id.trim() : '';
    if (!paneId) return false;          // an unroutable toast is worse than no toast
    pending.set(paneId, { title: clean(title, MAX.title), body: clean(body, MAX.body) });
    schedule();
    return true;
  }

  /** Register a click handler, fn(paneId). Returns a function that removes it. */
  function onActivate(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, Math.max(burstMs, lastShownAt + minGapMs - Date.now()));
    timer.unref?.();                    // a queued toast must never hold the process open
  }

  function flush() {
    timer = null;
    const entries = [...pending];
    pending.clear();
    if (!entries.length) return;
    lastShownAt = Date.now();

    // The longest-waiting pane owns the click, matching the inbox's
    // "jump to the longest-waiting agent" hotkey (SPEC 4).
    const [id, first] = entries[0];
    const many = entries.length > 1;

    // SPEC 4: approve is never offered on a truncated request. A toast is two
    // lines and Windows elides past that, so the full request text can never be
    // guaranteed visible here — these toasts carry no action buttons at all.
    const toast = {
      title: many ? `${entries.length} agents need you` : (first.title || 'Agent needs you'),
      body: many ? `${id}: ${first.body}` : first.body,
      buttons: [],
    };

    try {
      transport(toast, result => fire(result, id));
    } catch { /* transport is best-effort */ }
  }

  function fire(result, id) {
    const action = result?.action;
    if (action !== 'clicked' && action !== 'buttonClicked') return;
    for (const fn of listeners) {
      try { fn(id); } catch { /* one bad listener must not stop the others */ }
    }
  }

  return { notify, onActivate };
}

/** Toast text reaches SnoreToast as argv. Keep it printable, single-line, short,
 *  and never leading-dash, which an argument parser would read as a flag. */
function clean(text, max) {
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/^-+/, '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function snoreToast({ title, body }, done) {
  backend.notify(
    { title, message: body || title, wait: true, timeout: TOAST_SECONDS },
    (err, _response, meta) => done(err ? null : { action: meta?.action, button: meta?.button }),
  );
}

const shared = createNotifier();
export const notify = shared.notify;
export const onActivate = shared.onActivate;

// Manual check, not a test: `node src/notify.mjs` raises one real toast. Click it
// and the pane id prints. No automated test can assert that a toast was visible.
if (import.meta.main) {
  console.log('available:', available);
  onActivate(id => console.log('activated -> route to pane:', id));
  notify({ title: 'Claude needs you', body: 'run `rm -rf build`?', id: 'pane-7' });
  setTimeout(() => process.exit(0), 30_000);
}

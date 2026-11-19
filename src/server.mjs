import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { PaneRegistry } from './panes.mjs';
import { summarize } from './inbox.mjs';
import { notify, onActivate } from './notify.mjs';
import { isRepo, createPen, removePen, sweep, listPens, BRANCH_PREFIX } from './git.mjs';
import { available, defaultShellId } from './shell.mjs';

const PORT = Number(process.env.PORT ?? 7777);
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' };

// Binding to 127.0.0.1 is NOT access control. WebSockets ignore the same-origin
// policy entirely, so without this check any page you happen to be browsing
// could open ws://127.0.0.1:PORT and type into your shells. Browsers always
// send Origin on a WS handshake and on cross-origin fetch, so an absent Origin
// means a non-browser client (curl, the tests) - which already has local code
// execution and so gains nothing here.
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const originOk = req => {
  const origin = req.headers.origin;
  return origin === undefined || ALLOWED_ORIGINS.has(origin);
};

// Static files come from two fixed maps only; nothing else is reachable.
const SERVE = {
  '/': 'public/index.html',
  '/app.mjs': 'public/app.mjs',
};
const VENDOR = {
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
};

const registry = new PaneRegistry();

const inbox = () => {
  const panes = registry.describe();
  const snapshot = summarize(panes, Date.now());
  // An exited lamb keeps its row, and that row is now the only place its pen is
  // reachable from - untended lists pens with no pane at all. So the row has to
  // carry the path, or there is no way back into the pen. `order` and `buckets`
  // share the same row objects, so one pass covers both.
  const pens = new Map(panes.filter(p => p.exit && p.pen).map(p => [p.id, p.pen.path]));
  for (const row of snapshot.order) if (pens.has(row.id)) row.penPath = pens.get(row.id);
  return snapshot;
};

// The flock works one repo at a time. Session-scoped on purpose: pens outlive
// the orchestrator (see DELETE /api/panes), so there is nothing to persist.
let repo = null;
let lambCount = 0;

// Pens outlive the orchestrator, so after a restart there are worktrees full of
// agent output with no lamb in them. They are still *registered* worktrees, so
// sweep() correctly ignores them - it reports only what git has forgotten.
// Without this they are invisible in the UI and the surviving work is lost.
// Cached, not polled: `git worktree list` on a timer is exactly the Defender
// tax the research warned about. Refreshed only when the fleet actually moves.
let abandonedCache = [];

// Serialized, so two overlapping refreshes can never write their results out of
// order and leave the cache describing a fleet that has already moved on.
let refreshChain = Promise.resolve();
const refreshAbandoned = () => (refreshChain = refreshChain.then(computeAbandoned, computeAbandoned));

async function computeAbandoned() {
  if (!repo) { abandonedCache = []; return; }
  // Untended means *no pane object at all* - the post-restart case this bucket
  // exists for. An exited lamb still holds its pen: its row is on the board
  // with its own tend and cull, so listing the pen here too would put one pen
  // in two places with two different culls.
  const held = new Set(registry.describe().map(p => p.pen?.path).filter(Boolean));
  const pens = await listPens(repo).catch(() => []);
  abandonedCache = pens
    .filter(w => w.branch?.startsWith(BRANCH_PREFIX))   // ours, never the main worktree
    .filter(w => !held.has(w.path))
    .map(w => ({ path: w.path, branch: w.branch, locked: w.locked }));
}

// A lamb can leave its pen with no API call at all - the agent finishes or
// crashes and the shell exits by itself - so the cache has to follow the fleet,
// not the HTTP handlers. Deliberately NOT on 'status': agents report OSC 7501
// many times a second and this shells out to git, which is the Defender tax
// SPEC §5 exists to avoid. Not on 'touch' either (that is our own echo) nor on
// 'shutdown' - a git child whose cwd is the repo outlives us and then Windows
// will not let anything delete that directory.
registry.watch(reason => {
  if (reason !== 'roster' && reason !== 'exit') return;
  refreshAbandoned().then(() => registry.touch());
});

// Toast only on the *transition* into needsYou. Re-notifying every poll for a
// pane that is still blocked is how a notifier trains you to ignore it.
const notified = new Set();
function toastNewlyBlocked(snapshot) {
  const blocked = new Set((snapshot.buckets.needsYou ?? []).map(r => r.id));
  for (const id of notified) if (!blocked.has(id)) notified.delete(id);

  for (const row of snapshot.buckets.needsYou ?? []) {
    if (notified.has(row.id)) continue;
    notified.add(row.id);
    // No Approve affordance here by design: a toast cannot guarantee the full
    // request is visible, and SPEC forbids approving what you cannot read.
    notify({ title: `${row.title} needs you`, body: row.detail?.msg || row.status, id: row.id });
  }
}

// A toast click should land you on that exact pane, per SPEC's "one key opens
// the exact session". Browsers can't be focused from here, so tell every open
// tab to switch; if none is open, the pane is still top of the board.
const focusRequests = new Set();
onActivate(id => { for (const fn of focusRequests) fn(id); });

async function sendFile(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = req => new Promise(resolve => {
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;

  // Everything under /api can read pane ids or spawn shells. Gate the lot.
  if (path.startsWith('/api/') && !originOk(req)) return json(res, 403, { error: 'bad origin' });

  // the only thing in the console was this 404; nothing to serve, so say so
  if (path === '/favicon.ico') return res.writeHead(204).end();

  if (req.method === 'GET' && SERVE[path]) return sendFile(res, join(ROOT, SERVE[path]));
  if (req.method === 'GET' && VENDOR[path]) return sendFile(res, join(ROOT, 'node_modules', normalize(VENDOR[path])));
  if (req.method === 'GET' && path === '/api/shells') {
    return json(res, 200, { shells: available(), default: defaultShellId() });
  }
  if (req.method === 'GET' && path === '/api/inbox') {
    return json(res, 200, { ...inbox(), abandoned: abandonedCache });
  }

  if (req.method === 'GET' && path === '/api/repo') {
    return json(res, 200, { repo, strays: repo ? await sweep(repo).catch(() => []) : [] });
  }

  if (req.method === 'POST' && path === '/api/repo') {
    const { path: dir } = await readBody(req);
    if (!dir || !await isRepo(dir)) return json(res, 400, { error: `not a git repository: ${dir}` });
    repo = dir;
    // Pens outlive the orchestrator but `lambCount` does not, so a fresh run
    // would ask for lamb-1 again, collide with the pen on disk, and get named
    // "lamb-1-2". Resume numbering above whatever already exists.
    lambCount = (await listPens(repo).catch(() => []))
      .reduce((max, w) => Math.max(max, Number(/lamb-(\d+)\b/.exec(w.branch ?? w.path ?? '')?.[1] ?? 0)), 0);
    await refreshAbandoned();
    registry.touch();
    return json(res, 200, { repo });
  }

  if (req.method === 'DELETE' && path === '/api/pens') {
    const { path: penPath } = await readBody(req);
    const target = abandonedCache.find(p => p.path === penPath);
    if (!target) return json(res, 404, { error: `no abandoned pen at ${penPath}` });
    try {
      await removePen({ repo, path: target.path });
      await refreshAbandoned();
      registry.touch();
      return json(res, 200, { culled: target.path });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  if (req.method === 'POST' && path === '/api/panes') {
    const { shellId, cwd, title, penPath } = await readBody(req);
    let pen = null;
    let made = false;
    try {
      if (penPath) {
        // Tending: put a lamb back into an existing pen. Its work is already
        // there, so we must NOT create a worktree or touch the branch.
        // Two places a pen we know about can be: untended (no pane object at
        // all) or still attached to an exited lamb's row. The caller's path is
        // never used as a path - it only ever selects one of those records, so
        // an arbitrary directory can never be tended.
        pen = abandonedCache.find(p => p.path === penPath)
          ?? registry.describe().find(p => p.exit && p.pen?.path === penPath)?.pen;
        if (!pen) throw new Error(`no abandoned pen at ${penPath}`);
        // The dead lamb whose shell exited still has a row pointing at this
        // pen. Forget it, or deleting that row later would remove the pen out
        // from under the lamb we are about to put in it.
        for (const p of registry.describe()) if (p.exit && p.pen?.path === penPath) registry.close(p.id);
      } else if (repo) {
        // Every lamb gets its own pen, so two agents can never edit the same file.
        pen = await createPen({ repo, slug: `lamb-${++lambCount}` });
        made = true;
      }
      const pane = registry.create({ shellId, cwd: pen?.path ?? cwd, title, pen });
      await refreshAbandoned();            // a tended pen is no longer abandoned
      return json(res, 201, {
        id: pane.id, title: pane.title, shell: pane.shellId, cwd: pane.cwd,
        pen, warnings: pen?.warnings ?? [],
      });
    } catch (err) {
      // Only clean up a pen WE just made. Deleting a tended pen here would
      // destroy the surviving work we were trying to rescue.
      if (pen && made) removePen({ repo, path: pen.path }).catch(() => {});
      return json(res, 400, { error: err.message });
    }
  }

  const close = path.match(/^\/api\/panes\/([\w-]+)$/);
  if (req.method === 'DELETE' && close) {
    const pane = registry.get(close[1]);
    if (!pane) return json(res, 404, { error: `no such lamb: ${close[1]}` });
    const pen = pane.pen;

    // Order matters: the process tree dies first (git.mjs documents this as a
    // precondition), because Windows will not delete a directory that is any
    // live process's CWD.
    registry.close(close[1]);
    if (pen && repo) {
      try { await removePen({ repo, path: pen.path }); }
      catch (err) { return json(res, 200, { closed: close[1], penError: err.message }); }
    }
    await refreshAbandoned();
    return json(res, 200, { closed: close[1] });
  }

  res.writeHead(404).end('not found');
});

// Reject at the handshake, so a hostile page never gets an open socket at all.
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => originOk(req) });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  if (params.get('fleet') !== null) return attachFleet(ws);
  attachPane(ws, params.get('pane'));
});

/** Pushes the inbox on every fleet change. One socket per browser tab. */
function attachFleet(ws) {
  const push = () => {
    const snapshot = inbox();
    toastNewlyBlocked(snapshot);
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'inbox', ...snapshot, abandoned: abandonedCache }));
    }
  };
  const stop = registry.watch(push);
  push();

  const focus = id => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'focus', id }));
  focusRequests.add(focus);

  // Staleness is time-based, so it changes with no event to hang off.
  const tick = setInterval(push, 5000);
  ws.on('close', () => { stop(); clearInterval(tick); focusRequests.delete(focus); });
}

/** Attaches a viewer to an existing pane. Detaching does NOT kill the pane. */
function attachPane(ws, id) {
  const pane = registry.get(id);
  if (!pane) {
    ws.send(JSON.stringify({ type: 'error', message: `no such pane: ${id}` }));
    return ws.close();
  }

  ws.send(JSON.stringify({ type: 'ready', id: pane.id, title: pane.title, shell: pane.shellId, cwd: pane.cwd }));
  if (pane.buffer.length) ws.send(pane.buffer);   // replay scrollback to a reconnecting viewer

  const unsubscribe = pane.subscribe((bytes, exit) => {
    if (ws.readyState !== ws.OPEN) return;
    if (exit) ws.send(JSON.stringify({ type: 'exit', ...exit }));
    else ws.send(bytes);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return pane.write(data.toString('utf8'));
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'input') pane.write(msg.data);
    else if (msg.type === 'resize') pane.resize(msg.cols, msg.rows);
    else if (msg.type === 'interrupt') pane.interrupt();
  });

  // Only the viewer goes away. The pane keeps running.
  ws.on('close', unsubscribe);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  // Kills the agent trees but deliberately leaves the pens on disk: the work is
  // in them. Only an explicit cull removes a pen; sweep() reclaims any strays.
  process.on(sig, () => { registry.disposeAll(); process.exit(0); });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`orchestrator  http://127.0.0.1:${PORT}`);
  console.log(`shells        ${available().map(s => s.id).join(', ') || 'NONE FOUND'}`);
});

export { server, registry };

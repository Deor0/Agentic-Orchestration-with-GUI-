import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { PaneRegistry } from './panes.mjs';
import { summarize } from './inbox.mjs';
import { notify, onActivate } from './notify.mjs';
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
const inbox = () => summarize(registry.describe(), Date.now());

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
    notify({ title: `${row.title} needs you`, body: row.status, id: row.id });
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

  if (req.method === 'GET' && SERVE[path]) return sendFile(res, join(ROOT, SERVE[path]));
  if (req.method === 'GET' && VENDOR[path]) return sendFile(res, join(ROOT, 'node_modules', normalize(VENDOR[path])));
  if (req.method === 'GET' && path === '/api/shells') {
    return json(res, 200, { shells: available(), default: defaultShellId() });
  }
  if (req.method === 'GET' && path === '/api/inbox') return json(res, 200, inbox());

  if (req.method === 'POST' && path === '/api/panes') {
    const { shellId, cwd, title } = await readBody(req);
    try {
      const pane = registry.create({ shellId, cwd, title });
      return json(res, 201, { id: pane.id, title: pane.title, shell: pane.shellId, cwd: pane.cwd });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  const close = path.match(/^\/api\/panes\/([\w-]+)$/);
  if (req.method === 'DELETE' && close) {
    return json(res, registry.close(close[1]) ? 200 : 404, { closed: close[1] });
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
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'inbox', ...snapshot }));
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
  process.on(sig, () => { registry.disposeAll(); process.exit(0); });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`orchestrator  http://127.0.0.1:${PORT}`);
  console.log(`shells        ${available().map(s => s.id).join(', ') || 'NONE FOUND'}`);
});

export { server, registry };

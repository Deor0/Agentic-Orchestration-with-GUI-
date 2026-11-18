import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { Pane } from './pane.mjs';
import { available, defaultShellId } from './shell.mjs';

const PORT = Number(process.env.PORT ?? 7777);
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const MIME = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css' };

// Static files come from two fixed roots only; nothing else is reachable.
const SERVE = { '/': 'public/index.html', '/app.mjs': 'public/app.mjs' };
const VENDOR = {
  '/vendor/xterm.mjs': '@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': '@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': '@xterm/addon-fit/lib/addon-fit.mjs',
};

const panes = new Map();

async function send(res, file) {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (SERVE[path]) return send(res, join(ROOT, SERVE[path]));
  if (VENDOR[path]) return send(res, join(ROOT, 'node_modules', normalize(VENDOR[path])));
  if (path === '/api/shells') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ shells: available(), default: defaultShellId() }));
  }
  res.writeHead(404).end('not found');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  let pane;
  try {
    pane = new Pane({ shellId: params.get('shell') ?? undefined, cwd: params.get('cwd') ?? process.cwd() });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    return ws.close();
  }
  panes.set(pane.id, pane);
  ws.send(JSON.stringify({ type: 'ready', id: pane.id, shell: pane.shellId, cwd: pane.cwd }));

  // Replay what the pane already produced, so a reconnecting viewer sees history.
  if (pane.buffer.length) ws.send(pane.buffer);

  const unsubscribe = pane.subscribe((bytes, exit) => {
    if (ws.readyState !== ws.OPEN) return;
    if (exit) ws.send(JSON.stringify({ type: 'exit', ...exit }));
    else ws.send(bytes);
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return pane.write(data.toString('binary'));
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'input') pane.write(msg.data);
    else if (msg.type === 'resize') pane.resize(msg.cols, msg.rows);
    else if (msg.type === 'interrupt') pane.interrupt();
  });

  ws.on('close', () => {
    unsubscribe();
    // shortcut: pane dies with its viewer. Panes must outlive the browser
    // before this is a daily driver -- that is M2 (sessions in SQLite).
    pane.dispose();
    panes.delete(pane.id);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`orchestrator  http://127.0.0.1:${PORT}`);
  console.log(`shells        ${available().map(s => s.id).join(', ') || 'NONE FOUND'}`);
});

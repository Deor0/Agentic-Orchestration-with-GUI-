import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const PORT = 7911;
process.env.PORT = String(PORT);
process.env.ORCH_NO_TOASTS = '1';
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;

let server, registry;

before(async () => {
  ({ server, registry } = await import('../src/server.mjs'));
  if (!server.listening) await new Promise(r => server.once('listening', r));
});

after(() => { registry.disposeAll(); server.close(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await pred()) return true; await wait(100); }
  return false;
};

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** Attach a viewer and collect everything it receives. */
function viewer(id) {
  const ws = new WebSocket(`${WS}/?pane=${id}`);
  ws.binaryType = 'arraybuffer';
  const v = { text: '', msgs: [], ws, open: new Promise(r => ws.on('open', r)) };
  ws.on('message', (d, isBinary) => {
    if (isBinary) v.text += Buffer.from(d).toString('utf8');
    else v.msgs.push(JSON.parse(d.toString()));
  });
  return v;
}

test('creates a pane over HTTP', async () => {
  const { status, body } = await api('POST', '/api/panes', { title: 'first' });
  assert.equal(status, 201);
  assert.ok(body.id);
  assert.equal(body.title, 'first');
  await api('DELETE', `/api/panes/${body.id}`);
});

test('rejects an unknown shell without crashing', async () => {
  const { status, body } = await api('POST', '/api/panes', { shellId: 'nope' });
  assert.equal(status, 400);
  assert.match(body.error, /shell not installed/);
});

test('attaching to a missing pane errors instead of hanging', async () => {
  const v = viewer('does-not-exist');
  await v.open;
  assert.ok(await until(() => v.msgs.some(m => m.type === 'error')), 'no error message sent');
});

// The behaviour that defines this feature: closing the tab must not kill work.
test('a pane outlives its viewer, and a new viewer gets the scrollback', async () => {
  const { body: pane } = await api('POST', '/api/panes', { title: 'survivor' });

  const first = viewer(pane.id);
  await first.open;
  await wait(1800);
  first.ws.send(JSON.stringify({ type: 'input', data: '"BEFORE-DETACH"\r' }));
  assert.ok(await until(() => first.text.includes('BEFORE-DETACH')), 'command never ran');

  first.ws.close();                       // user closes the browser tab
  await wait(600);

  assert.ok(registry.get(pane.id), 'pane was disposed when its viewer left');
  assert.equal(registry.get(pane.id).exit, null, 'shell died with the viewer');

  const second = viewer(pane.id);         // user comes back
  await second.open;
  assert.ok(await until(() => second.text.includes('BEFORE-DETACH')),
    'scrollback was not replayed to the reconnecting viewer');

  second.ws.send(JSON.stringify({ type: 'input', data: '"STILL-ALIVE"\r' }));
  assert.ok(await until(() => second.text.includes('STILL-ALIVE')), 'pane no longer usable');

  second.ws.close();
  await api('DELETE', `/api/panes/${pane.id}`);
});

test('the inbox reports a blocked agent and ranks it first', async () => {
  const { body: quiet } = await api('POST', '/api/panes', { title: 'quiet one' });
  const { body: stuck } = await api('POST', '/api/panes', { title: 'stuck one' });

  const v = viewer(stuck.id);
  await v.open;
  await wait(1800);
  const esc = '$([char]27)';
  v.ws.send(JSON.stringify({
    type: 'input',
    data: `[Console]::Write("${esc}]7501;state=blocked:kind=permission${esc}\\")\r`,
  }));

  const ranked = await until(async () => {
    const { body } = await api('GET', '/api/inbox');
    return body.buckets.needsYou?.[0]?.id === stuck.id;
  });
  assert.ok(ranked, 'blocked pane never reached the top of needsYou');

  const { body } = await api('GET', '/api/inbox');
  assert.equal(body.counts.needsYou, 1, 'the quiet pane should not be in needsYou');
  assert.equal(body.buckets.needsYou[0].confidence, 'reported');

  v.ws.close();
  await api('DELETE', `/api/panes/${stuck.id}`);
  await api('DELETE', `/api/panes/${quiet.id}`);
});

test('the fleet socket pushes an inbox snapshot', async () => {
  const ws = new WebSocket(`${WS}/?fleet=1`);
  const got = [];
  ws.on('message', d => got.push(JSON.parse(d.toString())));
  await new Promise(r => ws.on('open', r));

  assert.ok(await until(() => got.some(m => m.type === 'inbox')), 'no inbox snapshot on connect');

  const { body: pane } = await api('POST', '/api/panes', { title: 'pushes' });
  assert.ok(await until(() => got.some(m => m.order?.some(r => r.id === pane.id))),
    'creating a pane did not push an update');

  ws.close();
  await api('DELETE', `/api/panes/${pane.id}`);
});

test('deleting a pane kills it and removes it from the inbox', async () => {
  const { body: pane } = await api('POST', '/api/panes', { title: 'doomed' });
  await wait(1800);
  const pid = registry.get(pane.id).pty.pid;

  assert.equal((await api('DELETE', `/api/panes/${pane.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/panes/${pane.id}`)).status, 404);

  const { body } = await api('GET', '/api/inbox');
  assert.ok(!body.order.some(r => r.id === pane.id), 'closed pane still in the inbox');

  const gone = await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.ok(gone, `shell pid ${pid} survived delete`);
});

// --- origin gating -----------------------------------------------------
// Binding to localhost is not access control: WebSockets ignore same-origin,
// so a hostile page could otherwise drive a shell as the user.

const wsWithOrigin = origin => new Promise(resolve => {
  const ws = new WebSocket(`${WS}/?fleet=1`, origin ? { headers: { origin } } : undefined);
  ws.on('open', () => { ws.close(); resolve('open'); });
  ws.on('error', () => resolve('rejected'));
});

test('a websocket from a hostile origin is rejected at the handshake', async () => {
  assert.equal(await wsWithOrigin('https://evil.example'), 'rejected');
});

test('a websocket from our own page is accepted', async () => {
  assert.equal(await wsWithOrigin(`http://127.0.0.1:${PORT}`), 'open');
  assert.equal(await wsWithOrigin(`http://localhost:${PORT}`), 'open');
});

test('a websocket with no origin is accepted (non-browser client)', async () => {
  assert.equal(await wsWithOrigin(null), 'open');
});

test('an api call from a hostile origin is refused', async () => {
  // text/plain dodges the CORS preflight, so this is the shape an attacker uses.
  const res = await fetch(`${BASE}/api/panes`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
    body: '{"title":"pwned"}',
  });
  assert.equal(res.status, 403);

  const { body } = await api('GET', '/api/inbox');
  assert.ok(!body.order.some(r => r.title === 'pwned'), 'hostile origin created a pane');
});

test('reading the inbox from a hostile origin is refused', async () => {
  const res = await fetch(`${BASE}/api/inbox`, { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

// --- pens (git worktrees) ---------------------------------------------
// Covers the wiring only: git.mjs has its own suite for the twelve rules.

import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

let testRepo = null;

async function makeRepo() {
  const dir = await mkdtemp(pjoin(tmpdir(), 'cult-wire-'));
  await run('git', ['-c', 'init.defaultBranch=main', 'init', dir]);
  await writeFile(pjoin(dir, 'README.md'), '# fixture\n');
  await run('git', ['-C', dir, 'add', '.']);
  await run('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  return dir;
}

// Retries matter: a git child or a pty that is on its way out can still hold
// the repo, and Windows refuses to delete a directory anything has open. A
// swallowed failure here is how %TEMP% fills up with cult-* repos.
after(async () => {
  if (testRepo) await rm(testRepo, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {});
});

test('a non-repo path is refused as the flock ground', async () => {
  const { status, body } = await api('POST', '/api/repo', { path: tmpdir() });
  assert.equal(status, 400);
  assert.match(body.error, /not a git repository/);
});

test('choosing a repo, then raising a lamb, gives it its own pen', async () => {
  testRepo = await makeRepo();
  assert.equal((await api('POST', '/api/repo', { path: testRepo })).status, 200);
  assert.equal((await api('GET', '/api/repo')).body.repo, testRepo);

  const { status, body } = await api('POST', '/api/panes', {});
  assert.equal(status, 201, `raise failed: ${JSON.stringify(body)}`);
  assert.ok(body.pen?.path, 'lamb got no pen');
  assert.match(body.pen.branch, /^cult\//);
  assert.ok(existsSync(body.pen.path), 'pen directory does not exist');
  assert.equal(body.cwd, body.pen.path, 'shell did not start inside the pen');
  assert.ok(!body.title.includes('cult/'), 'branch prefix leaked into the display title');

  // culling must take the pen with it
  await wait(1500);
  assert.equal((await api('DELETE', `/api/panes/${body.id}`)).status, 200);
  const gone = await until(() => !existsSync(body.pen.path), 10000);
  assert.ok(gone, `pen survived the cull: ${body.pen.path}`);
});

test('two lambs get different pens', async () => {
  const a = (await api('POST', '/api/panes', {})).body;
  const b = (await api('POST', '/api/panes', {})).body;
  assert.notEqual(a.pen.path, b.pen.path);
  assert.notEqual(a.pen.branch, b.pen.branch);
  await wait(1500);
  await api('DELETE', `/api/panes/${a.id}`);
  await api('DELETE', `/api/panes/${b.id}`);
});

// --- abandoned pens ----------------------------------------------------
// Pens survive a restart. Without this bucket the surviving work is invisible:
// it is still a *registered* worktree, so sweep() correctly ignores it.

test('a pen whose lamb is gone shows up as abandoned, and can be tended', async () => {
  assert.equal((await api('POST', '/api/repo', { path: testRepo })).status, 200);

  const first = (await api('POST', '/api/panes', {})).body;
  await wait(1500);
  const penPath = first.pen.path;
  const branch = first.pen.branch;

  // simulate the restart case: the lamb dies, the pen stays on disk
  registry.close(first.id);
  await wait(300);

  const { body: inboxBody } = await api('GET', '/api/inbox');
  const found = inboxBody.abandoned.find(p => p.path === penPath);
  assert.ok(found, `pen ${penPath} was not reported as abandoned`);
  assert.equal(found.branch, branch);
  assert.ok(existsSync(penPath), 'pen should still be on disk');

  // tending puts a lamb back in WITHOUT making a new worktree
  const { status, body: tended } = await api('POST', '/api/panes', { penPath });
  assert.equal(status, 201, `tend failed: ${JSON.stringify(tended)}`);
  assert.equal(tended.cwd, penPath, 'tended lamb did not start in the pen');
  assert.equal(tended.pen.branch, branch, 'tending changed the branch');

  const after = (await api('GET', '/api/inbox')).body;
  assert.ok(!after.abandoned.some(p => p.path === penPath), 'still listed as abandoned after tending');

  await wait(1200);
  await api('DELETE', `/api/panes/${tended.id}`);
});

// The case a user actually hits: nobody closed anything, the agent's own shell
// ended. Nothing but the exit event can make the pen visible again.
test('a pen whose shell exits by itself becomes abandoned with no api call', async () => {
  assert.equal((await api('POST', '/api/repo', { path: testRepo })).status, 200);
  const lamb = (await api('POST', '/api/panes', {})).body;
  const penPath = lamb.pen.path;
  try {
    await wait(1800);
    registry.get(lamb.id).write('exit 0\r');
    assert.ok(await until(() => registry.get(lamb.id)?.exit != null), 'the shell never exited');

    const found = await until(async () =>
      (await api('GET', '/api/inbox')).body.abandoned.some(p => p.path === penPath));
    assert.ok(found, `pen ${penPath} was not reported as abandoned after its shell exited`);
  } finally {
    await api('DELETE', `/api/panes/${lamb.id}`).catch(() => {});
    await api('DELETE', '/api/pens', { path: penPath }).catch(() => {});
  }
});

test('tending a pen that is not abandoned is refused', async () => {
  const { status, body } = await api('POST', '/api/panes', { penPath: 'C:\wt\does-not-exist' });
  assert.equal(status, 400);
  assert.match(body.error, /no abandoned pen/);
});

test('culling an abandoned pen removes it from disk', async () => {
  const lamb = (await api('POST', '/api/panes', {})).body;
  await wait(1500);
  const penPath = lamb.pen.path;
  registry.close(lamb.id);
  await wait(300);
  assert.ok((await api('GET', '/api/inbox')).body.abandoned.some(p => p.path === penPath));

  assert.equal((await api('DELETE', '/api/pens', { path: penPath })).status, 200);
  assert.ok(await until(() => !existsSync(penPath), 10000), 'pen survived the cull');
  assert.ok(!(await api('GET', '/api/inbox')).body.abandoned.some(p => p.path === penPath));

  assert.equal((await api('DELETE', '/api/pens', { path: penPath })).status, 404);
});

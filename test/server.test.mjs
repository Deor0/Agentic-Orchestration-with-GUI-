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

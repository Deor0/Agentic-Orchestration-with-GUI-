import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, BUCKETS } from '../src/inbox.mjs';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

/** A running pane that reported `status` just now and printed output just now. */
const pane = (id, over = {}) => ({
  id,
  title: `claude — ${id}`,
  status: 'working',
  statusAt: NOW,
  lastOutputAt: NOW,
  exit: null,
  ...over,
});

const ids = rows => rows.map(r => r.id);

test('empty input gives empty buckets, order and counts', () => {
  const { buckets, order, counts } = summarize([], NOW);
  assert.deepEqual(order, []);
  assert.deepEqual(Object.keys(buckets), BUCKETS);
  for (const b of BUCKETS) {
    assert.deepEqual(buckets[b], []);
    assert.equal(counts[b], 0);
  }
});

test('each reported status lands in its bucket', () => {
  for (const [status, bucket] of [
    ['blocked', 'needsYou'],
    ['blocked:permission', 'needsYou'],
    ['blocked:question', 'needsYou'],
    ['blocked:auth', 'needsYou'],
    ['error', 'failed'],
    ['working', 'working'],
    ['done', 'idle'],   // turn finished, lamb still alive and waiting
    ['idle', 'idle'],
  ]) {
    const { buckets } = summarize([pane('a', { status })], NOW);
    assert.deepEqual(ids(buckets[bucket]), ['a'], status);
  }
});

test('bare blocked with no kind is still needsYou', () => {
  const { order } = summarize([pane('a', { status: 'blocked', statusAt: NOW - MIN })], NOW);
  assert.equal(order[0].bucket, 'needsYou');
  assert.equal(order[0].waitingMs, MIN);
});

test('needsYou is longest-waiting first and order[0] is the hotkey target', () => {
  const { buckets, order } = summarize([
    pane('recent', { status: 'blocked:permission', statusAt: NOW - 1 * MIN }),
    pane('oldest', { status: 'blocked:question', statusAt: NOW - 30 * MIN }),
    pane('middle', { status: 'blocked', statusAt: NOW - 5 * MIN }),
    pane('busy'),
  ], NOW);
  assert.deepEqual(ids(buckets.needsYou), ['oldest', 'middle', 'recent']);
  assert.equal(order[0].id, 'oldest');
  assert.deepEqual(ids(order), ['oldest', 'middle', 'recent', 'busy']);
});

test('ties in waitingMs keep input order', () => {
  const at = NOW - 3 * MIN;
  const { buckets } = summarize(
    ['a', 'b', 'c', 'd'].map(id => pane(id, { status: 'blocked', statusAt: at })), NOW);
  assert.deepEqual(ids(buckets.needsYou), ['a', 'b', 'c', 'd']);
});

test('order follows bucket priority: needsYou, failed, working, done, idle', () => {
  const { order } = summarize([
    pane('i', { status: 'idle' }),
    // only a clean exit reaches the done bucket - a reported `done` is idle
    pane('d', { exit: { exitCode: 0 } }),
    pane('w', { status: 'working' }),
    pane('f', { status: 'error' }),
    pane('n', { status: 'blocked', statusAt: NOW - MIN }),
  ], NOW);
  assert.deepEqual(ids(order), ['n', 'f', 'w', 'd', 'i']);
  assert.deepEqual(order.map(r => r.bucket), BUCKETS);
});

test('exit code outranks status: non-zero fails, zero is done', () => {
  const quietWorking = { status: 'working', lastOutputAt: NOW - 60 * MIN };
  const { buckets } = summarize([
    pane('crashed', { ...quietWorking, exit: { exitCode: 7, signal: null } }),
    pane('finished', { ...quietWorking, exit: { exitCode: 0, signal: null } }),
    pane('blocked-but-dead', { status: 'blocked:permission', statusAt: NOW - MIN, exit: { exitCode: 1, signal: null } }),
  ], NOW);
  assert.deepEqual(ids(buckets.failed), ['crashed', 'blocked-but-dead']);
  assert.deepEqual(ids(buckets.done), ['finished']);
  assert.deepEqual(buckets.needsYou, []);
  assert.equal(buckets.failed[0].exitCode, 7);
  assert.equal(buckets.failed[0].confidence, 'reported');
});

test('never-reported pane with recent output is working, marked inferred', () => {
  const { buckets } = summarize([pane('a', { status: null, statusAt: null })], NOW);
  assert.deepEqual(ids(buckets.working), ['a']);
  assert.equal(buckets.working[0].confidence, 'inferred');
  assert.equal(buckets.working[0].stale, false);
  assert.equal(buckets.working[0].status, null);
});

test('a quiet pane is stale and never needsYou, however long it has been quiet', () => {
  for (const quietFor of [6 * MIN, 60 * MIN, 24 * 60 * MIN, 365 * 24 * 60 * MIN]) {
    for (const status of ['working', null]) {
      const { buckets, order } = summarize(
        [pane('a', { status, statusAt: status ? NOW - quietFor : null, lastOutputAt: NOW - quietFor })], NOW);
      assert.deepEqual(buckets.needsYou, [], `${status} quiet ${quietFor}`);
      assert.deepEqual(ids(buckets.working), ['a']);
      assert.equal(order[0].stale, true);
    }
  }
});

test('a pane that never produced output is stale, not needsYou', () => {
  const { buckets } = summarize([pane('a', { status: null, statusAt: null, lastOutputAt: null })], NOW);
  assert.deepEqual(buckets.needsYou, []);
  assert.equal(buckets.working[0].stale, true);
  assert.equal(buckets.working[0].confidence, 'inferred');
});

test('staleMs is an option', () => {
  const p = [pane('a', { lastOutputAt: NOW - 10_000 })];
  assert.equal(summarize(p, NOW).buckets.working[0].stale, false);
  assert.equal(summarize(p, NOW, { staleMs: 5_000 }).buckets.working[0].stale, true);
});

test('confidence is reported for agent-reported states and real exits', () => {
  const rows = summarize([
    pane('s', { status: 'blocked:auth', statusAt: NOW - MIN }),
    pane('e', { exit: { exitCode: 0, signal: null }, status: null, statusAt: null }),
    pane('h', { status: null, statusAt: null }),
  ], NOW).order;
  assert.deepEqual(
    Object.fromEntries(rows.map(r => [r.id, r.confidence])),
    { s: 'reported', e: 'reported', h: 'inferred' });
});

test('waitingMs is present only on blocked rows and is computed from the injected now', () => {
  const { order } = summarize([
    pane('n', { status: 'blocked:question', statusAt: NOW - 7 * MIN }),
    pane('w'),
    pane('d', { status: 'done' }),
    pane('f', { status: 'error' }),
    pane('i', { status: 'idle' }),
  ], NOW);
  assert.equal(order[0].waitingMs, 7 * MIN);
  for (const r of order.slice(1)) assert.ok(!('waitingMs' in r), `${r.id} has waitingMs`);

  // Same panes, clock moved on: waitingMs tracks `now`, nothing else does.
  const later = summarize([pane('n', { status: 'blocked:question', statusAt: NOW - 7 * MIN })], NOW + MIN);
  assert.equal(later.order[0].waitingMs, 8 * MIN);
});

test('blocked with statusAt null produces no NaN anywhere', () => {
  const { order } = summarize([pane('a', { status: 'blocked', statusAt: null })], NOW);
  assert.equal(order[0].bucket, 'needsYou');
  assert.equal(order[0].waitingMs, 0);
  assert.ok(!JSON.stringify(order).includes('null,"waitingMs":null'));
  for (const v of Object.values(order[0])) assert.ok(!Number.isNaN(v), String(v));
});

test('a statusAt in the future clamps to 0 rather than going negative', () => {
  const { order } = summarize([pane('a', { status: 'blocked', statusAt: NOW + MIN })], NOW);
  assert.equal(order[0].waitingMs, 0);
});

test('rows carry what a row needs to render', () => {
  const [r] = summarize([pane('p1', { status: 'blocked:permission', statusAt: NOW - MIN })], NOW).order;
  assert.deepEqual(r, {
    id: 'p1',
    title: 'claude — p1',
    bucket: 'needsYou',
    status: 'blocked:permission',
    detail: null,
    exitCode: null,
    confidence: 'reported',
    stale: false,
    waitingMs: MIN,
  });
});

test('counts match the buckets', () => {
  const { buckets, counts, order } = summarize([
    pane('a', { status: 'blocked', statusAt: NOW - MIN }),
    pane('b', { status: 'blocked', statusAt: NOW - 2 * MIN }),
    pane('c', { status: 'error' }),
    pane('d'),
  ], NOW);
  assert.deepEqual(counts, { needsYou: 2, failed: 1, working: 1, done: 0, idle: 0 });
  assert.equal(order.length, 4);
  for (const b of BUCKETS) assert.equal(counts[b], buckets[b].length);
});

test('deterministic: same input and same now give identical output', () => {
  const panes = [
    pane('a', { status: 'blocked', statusAt: NOW - MIN }),
    pane('b', { status: null, statusAt: null, lastOutputAt: NOW - 90 * MIN }),
    pane('c', { exit: { exitCode: 2, signal: null } }),
    pane('d', { status: 'idle' }),
  ];
  const a = summarize(panes, NOW);
  const b = summarize(panes.slice(), NOW);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('summarize does not mutate its input', () => {
  const panes = [pane('a', { status: 'blocked', statusAt: NOW - MIN }), pane('b')];
  const before = JSON.stringify(panes);
  summarize(panes, NOW);
  assert.equal(JSON.stringify(panes), before);
});

// Regressions from the first hand-driven run (2026-11-19).

test('a reported done is idle, not done: the lamb is alive and awaiting you', () => {
  const { buckets } = summarize([pane('p', { status: 'done' })], NOW);
  assert.deepEqual(ids(buckets.idle), ['p'], 'a finished turn must not read as a finished lamb');
  assert.equal(buckets.done.length, 0);
});

test('an exited pane drops its stale status string', () => {
  // it had reported blocked, then the shell died
  const [r] = summarize([
    pane('p', { status: 'blocked:permission', statusAt: NOW - MIN, exit: { exitCode: 3 } }),
  ], NOW).order;
  assert.equal(r.bucket, 'failed');
  assert.equal(r.exitCode, 3);
  assert.equal(r.status, null, 'a dead pane still read as blocked');
  assert.equal(r.detail, null);
});

test('detail survives onto the row so the UI can show what was asked', () => {
  const detail = { msg: 'trust this folder', kind: 'permission', app: 'claude-code' };
  const [r] = summarize([
    pane('p', { status: 'blocked:permission', statusAt: NOW, detail }),
  ], NOW).order;
  assert.deepEqual(r.detail, detail, 'the request text never reached the row');
});

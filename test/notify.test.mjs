import test from 'node:test';
import assert from 'node:assert/strict';
import { available, createNotifier, notify, onActivate } from '../src/notify.mjs';

// Nothing here shows a real toast. The transport is faked so the queueing,
// coalescing and click-routing logic can be asserted; whether Windows actually
// draws the thing is the manual check at the bottom of src/notify.mjs.

const wait = ms => new Promise(r => setTimeout(r, ms));

/** A notifier on a fake transport. `toasts` records every toast it was asked to
 *  show, each with a `done` the test calls to answer as the user would. */
function harness(opts = {}) {
  const toasts = [];
  const seen = [];
  const n = createNotifier({
    transport: (toast, done) => toasts.push({ ...toast, done }),
    burstMs: 10,
    minGapMs: 40,
    ...opts,
  });
  n.onActivate(id => seen.push(id));
  return { ...n, toasts, seen };
}

test('the public surface loads on any platform', () => {
  assert.equal(typeof available, 'boolean');
  assert.equal(typeof notify, 'function');
  assert.equal(typeof onActivate, 'function');
});

test('the shared notifier never throws and rejects unroutable input', () => {
  // Deliberately no valid id: asserting the no-throw path must not fire a real toast.
  assert.doesNotThrow(() => { notify(); notify(null); notify({ title: 'x' }); });
  assert.equal(notify({ title: 'x', body: 'y', id: '' }), false);
  assert.equal(typeof onActivate(() => {}), 'function');
});

test('with no transport every notify is a silent no-op', async () => {
  const n = createNotifier({ transport: null });
  assert.equal(n.notify({ title: 't', body: 'b', id: 'pane-1' }), false);
  assert.doesNotThrow(() => { n.notify(); n.notify(null); });
  await wait(30);
});

test('a toast without a routable pane id is dropped', async () => {
  const h = harness();
  for (const id of [undefined, null, '', '   ', 7, {}, [], true]) {
    assert.equal(h.notify({ title: 't', body: 'b', id }), false, `id=${JSON.stringify(id)}`);
  }
  await wait(40);
  assert.deepEqual(h.toasts, []);
});

test('a lone block keeps the caller title and body', async () => {
  const h = harness();
  assert.equal(h.notify({ title: 'Claude', body: 'run rm -rf build?', id: 'pane-7' }), true);
  await wait(40);
  assert.equal(h.toasts.length, 1);
  assert.deepEqual([h.toasts[0].title, h.toasts[0].body], ['Claude', 'run rm -rf build?']);
});

test('a wave of blocked agents produces one toast, not a wall', async () => {
  const h = harness();
  for (let i = 1; i <= 8; i++) h.notify({ title: `Agent ${i}`, body: `needs you ${i}`, id: `pane-${i}` });
  await wait(40);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].title, /^8 agents need you$/);
});

test('repeat notifications for one pane collapse to its latest text', async () => {
  const h = harness();
  h.notify({ title: 'Claude', body: 'stale', id: 'pane-7' });
  h.notify({ title: 'Claude', body: 'current', id: 'pane-7' });
  await wait(40);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].body, 'current');
});

test('the minimum gap delays a later toast instead of dropping it', async () => {
  const h = harness({ burstMs: 10, minGapMs: 120 });
  h.notify({ title: 'a', body: 'first', id: 'pane-a' });
  await wait(40);
  assert.equal(h.toasts.length, 1);

  h.notify({ title: 'b', body: 'second', id: 'pane-b' });
  await wait(40);
  assert.equal(h.toasts.length, 1, 'still inside the gap');
  await wait(150);
  assert.equal(h.toasts.length, 2, 'delivered once the gap elapsed');
  assert.equal(h.toasts[1].body, 'second');
});

test('clicking a toast routes back to its pane id', async () => {
  const h = harness();
  h.notify({ title: 'Claude', body: 'x', id: 'pane-7' });
  await wait(40);
  h.toasts[0].done({ action: 'clicked' });
  assert.deepEqual(h.seen, ['pane-7']);
});

test('a button click routes; a timeout, dismissal or error does not', async () => {
  for (const [result, expected] of [
    [{ action: 'buttonClicked', button: 'Open' }, ['pane-1']],
    [{ action: 'timedout' }, []],
    [{ action: 'dismissed' }, []],
    [null, []],
    [undefined, []],
    [{}, []],
  ]) {
    const h = harness();
    h.notify({ title: 'a', body: 'a', id: 'pane-1' });
    await wait(40);
    assert.doesNotThrow(() => h.toasts[0].done(result));
    assert.deepEqual(h.seen, expected, JSON.stringify(result));
  }
});

test('a coalesced toast routes to the longest-waiting pane', async () => {
  const h = harness();
  h.notify({ title: 'a', body: 'blocked first', id: 'pane-a' });
  h.notify({ title: 'b', body: 'blocked second', id: 'pane-b' });
  h.notify({ title: 'c', body: 'blocked third', id: 'pane-c' });
  await wait(40);
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].body, /pane-a: blocked first/);
  h.toasts[0].done({ action: 'clicked' });
  assert.deepEqual(h.seen, ['pane-a']);
});

test('long text is truncated, and a truncated request carries no buttons', async () => {
  const h = harness();
  h.notify({ title: 'T'.repeat(300), body: 'B'.repeat(900), id: 'pane-a' });
  await wait(40);
  const [t] = h.toasts;
  assert.ok(t.title.length <= 64, `title ${t.title.length}`);
  assert.ok(t.body.length <= 180, `body ${t.body.length}`);
  assert.ok(t.body.endsWith('…'));
  assert.deepEqual(t.buttons, []);   // SPEC 4: approve is never offered on a truncated request
});

test('control characters and leading dashes are stripped from argv text', async () => {
  const h = harness();
  h.notify({ title: '--title\u0007', body: 'line one\nline two\u0000', id: 'pane-a' });
  await wait(40);
  assert.equal(h.toasts[0].title, 'title');
  assert.equal(h.toasts[0].body, 'line one line two');
});

test('an empty title falls back rather than showing a blank toast', async () => {
  const h = harness();
  h.notify({ body: 'something happened', id: 'pane-a' });
  await wait(40);
  assert.equal(h.toasts[0].title, 'Agent needs you');
});

test('a throwing listener does not stop the others', async () => {
  const h = harness();
  const late = [];
  h.onActivate(() => { throw new Error('boom'); });
  h.onActivate(id => late.push(id));
  h.notify({ title: 'a', body: 'a', id: 'pane-a' });
  await wait(40);
  assert.doesNotThrow(() => h.toasts[0].done({ action: 'clicked' }));
  assert.deepEqual([h.seen, late], [['pane-a'], ['pane-a']]);
});

test('onActivate returns a working unsubscribe and tolerates non-functions', async () => {
  const h = harness();
  const seen = [];
  h.onActivate(id => seen.push(id))();
  assert.doesNotThrow(() => h.onActivate('not a function')());
  h.notify({ title: 'a', body: 'a', id: 'pane-a' });
  await wait(40);
  h.toasts[0].done({ action: 'clicked' });
  assert.deepEqual(seen, []);
});

test('a transport that throws does not escape onto the timer', async () => {
  // flush() runs from setTimeout; an uncaught throw there would kill the server.
  const n = createNotifier({
    transport: () => { throw new Error('snoretoast missing'); },
    burstMs: 5,
    minGapMs: 5,
  });
  assert.equal(n.notify({ title: 'a', body: 'a', id: 'pane-a' }), true);
  await wait(40);
  assert.equal(n.notify({ title: 'b', body: 'b', id: 'pane-b' }), true, 'still usable afterwards');
  await wait(40);
});

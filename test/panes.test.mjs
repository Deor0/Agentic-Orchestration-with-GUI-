import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaneRegistry } from '../src/panes.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (pred, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (pred()) return true; await wait(100); }
  return false;
};

async function withRegistry(fn) {
  const reg = new PaneRegistry();
  try { return await fn(reg); } finally { reg.disposeAll(); }
}

test('a created pane is tracked and describable', async () => {
  await withRegistry(async reg => {
    const pane = reg.create({ title: 'agent one' });
    await wait(1800);

    assert.equal(reg.get(pane.id), pane);
    const [d] = reg.describe();
    assert.equal(d.id, pane.id);
    assert.equal(d.title, 'agent one');
    assert.equal(d.status, null, 'no agent has reported yet');
    assert.equal(d.exit, null);
    assert.ok(d.lastOutputAt, 'shell produced output but lastOutputAt was not stamped');
  });
});

test('a default title is derived when none is given', async () => {
  await withRegistry(async reg => {
    const pane = reg.create();
    assert.match(pane.title, /^Lamb · .+/);
  });
});

test('describe() reports an agent status reported over OSC 7501', async () => {
  await withRegistry(async reg => {
    const pane = reg.create();
    await wait(1800);
    const esc = '$([char]27)';
    pane.write(`[Console]::Write("${esc}]7501;state=blocked:kind=permission${esc}\\")\r`);

    assert.ok(await until(() => reg.describe()[0].status === 'blocked:permission'),
      'status never surfaced through the registry');
    assert.ok(reg.describe()[0].statusAt, 'statusAt not propagated');
  });
});

test('watchers fire when the fleet changes', async () => {
  await withRegistry(async reg => {
    let fired = 0;
    reg.watch(() => fired++);

    reg.create();
    assert.ok(fired >= 1, 'create did not notify watchers');

    const before = fired;
    await wait(1800);
    const esc = '$([char]27)';
    reg.describe(); // no-op read
    [...reg.panes.values()][0].write(`[Console]::Write("${esc}]7501;state=working${esc}\\")\r`);
    assert.ok(await until(() => fired > before), 'status change did not notify watchers');
  });
});

test('a throwing watcher does not take the registry down', async () => {
  await withRegistry(async reg => {
    reg.watch(() => { throw new Error('bad watcher'); });
    assert.doesNotThrow(() => reg.create());
  });
});

test('close() disposes the pane and forgets it', async () => {
  await withRegistry(async reg => {
    const pane = reg.create();
    await wait(1800);
    const pid = pane.pty.pid;

    assert.equal(reg.close(pane.id), true);
    assert.equal(reg.get(pane.id), undefined);
    assert.equal(reg.describe().length, 0);
    assert.equal(reg.close(pane.id), false, 'closing twice should report false');

    const gone = await until(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    assert.ok(gone, `shell pid ${pid} survived close()`);
  });
});

test('panes are independent of each other', async () => {
  await withRegistry(async reg => {
    const a = reg.create({ title: 'a' });
    const b = reg.create({ title: 'b' });
    await wait(1800);

    reg.close(a.id);
    assert.equal(reg.describe().length, 1);
    assert.equal(reg.describe()[0].title, 'b');
    assert.equal(b.exit, null, 'closing one pane killed another');
  });
});

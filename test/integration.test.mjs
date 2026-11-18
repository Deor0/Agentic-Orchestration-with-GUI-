import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pane } from '../src/pane.mjs';
import { mode } from '../src/jobkill.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));

async function withPane(fn) {
  const pane = new Pane({ cols: 80, rows: 24 });
  try {
    await wait(1800);
    return await fn(pane);
  } finally {
    pane.dispose();
  }
}

const until = async (pred, timeout = 6000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (pred()) return true; await wait(100); }
  return false;
};

test('panes are supervised by a real job object, not the leaky fallback', () => {
  assert.equal(mode, 'job', 'fell back to taskkill - grandchildren will leak');
});

test('a pane picks up an agent status reported over OSC 7501', async () => {
  await withPane(async pane => {
    assert.equal(pane.status, null, 'status should start empty');

    const seen = [];
    pane.onStatus(ev => seen.push(ev));

    // Emit the sequence the way a real agent would: straight to the console,
    // bypassing PowerShell's string parsing.
    const esc = '$([char]27)';
    pane.write(`[Console]::Write("${esc}]7501;state=blocked:kind=permission${esc}\\")\r`);

    assert.ok(await until(() => pane.status), 'no status event arrived');
    assert.equal(pane.status.status, 'blocked:permission');
    assert.equal(pane.status.confidence, 'reported');
    assert.ok(pane.statusAt, 'statusAt not stamped');
    assert.ok(seen.some(e => e.type === 'status'), 'onStatus listener never fired');
  });
});

test('a reported done status replaces the earlier blocked one', async () => {
  await withPane(async pane => {
    const esc = '$([char]27)';
    const emit = s => pane.write(`[Console]::Write("${esc}]7501;state=${s}${esc}\\")\r`);

    emit('blocked:kind=question');
    assert.ok(await until(() => pane.status?.status === 'blocked:question'), 'blocked never seen');

    emit('done');
    assert.ok(await until(() => pane.status?.status === 'done'), 'done never replaced blocked');
  });
});

test('dispose kills the shell', async () => {
  const pane = new Pane({ cols: 80, rows: 24 });
  await wait(1800);
  const pid = pane.pty.pid;
  assert.ok(pid > 0, 'pty never got a pid');

  pane.dispose();

  const gone = await until(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, 8000);
  assert.ok(gone, `shell pid ${pid} survived dispose()`);
});

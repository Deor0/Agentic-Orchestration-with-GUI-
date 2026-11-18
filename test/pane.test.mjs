import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pane } from '../src/pane.mjs';
import { defaultShellId, resolveShell } from '../src/shell.mjs';

const wait = ms => new Promise(r => setTimeout(r, ms));

/** Run fn once the shell has settled, then tear the pane down. */
async function withPane(fn) {
  const pane = new Pane({ cols: 80, rows: 24 });
  try {
    await wait(1800);
    return await fn(pane);
  } finally {
    pane.dispose();
  }
}

/** Wait until the pane's buffer matches, or give up. */
async function until(pane, pred, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred(pane.buffer.toString('utf8'))) return true;
    await wait(100);
  }
  return false;
}

test('a shell is installed and resolves to an absolute path', () => {
  const id = defaultShellId();
  assert.ok(id, 'no supported shell found on this machine');
  assert.match(resolveShell(id), /^[A-Za-z]:\\/, 'shell path must be absolute (hard rule 8)');
});

test('bare shell names are rejected', () => {
  assert.throws(() => new Pane({ shellId: 'nope' }), /shell not installed/);
});

// The regression that silently breaks everything: bundled ConPTY forwards DA1
// to the terminal and the shell produces no output until it is answered.
test('answers the DA1 query so the shell actually starts', async () => {
  await withPane(async pane => {
    const started = await until(pane, t => /PS .*>|\$ $/.test(t));
    assert.ok(started, 'shell never reached a prompt - DA1 likely unanswered');
  });
});

test('runs a command and captures its output', async () => {
  await withPane(async pane => {
    pane.write('"MARK-' + 'ok"\r');
    assert.ok(await until(pane, t => t.includes('MARK-ok')), 'command output never appeared');
  });
});

test('interrupt() stops a running command and leaves the shell usable', async () => {
  await withPane(async pane => {
    pane.write('Start-Sleep -Seconds 30\r');
    await wait(900);
    pane.interrupt();
    await wait(1000);
    pane.write('"ALIVE"\r');
    assert.ok(await until(pane, t => t.includes('ALIVE')), 'shell did not survive Ctrl-C');
  });
});

test('drops the viewer auto-replies the server already sent', async () => {
  await withPane(async pane => {
    // Observe what reaches the pty directly. Asserting "buffer did not grow"
    // instead makes this a race against any late shell output.
    const sent = [];
    const real = pane.pty.write.bind(pane.pty);
    pane.pty.write = d => { sent.push(d); return real(d); };

    pane.write('\u001b[?1;2c');            // xterm.js's own DA1 answer - must be dropped
    assert.deepEqual(sent, [], 'duplicate DA1 reply was forwarded to the shell');

    pane.write('x');                       // a real keystroke still gets through
    assert.deepEqual(sent, ['x']);
  });
});

// ConPTY children default to the OEM code page (IBM437 here), which mangles
// every non-ASCII byte an agent emits.
test('shell starts in UTF-8, not the OEM code page', async () => {
  await withPane(async pane => {
    pane.write('[Console]::OutputEncoding.WebName\r');
    assert.ok(await until(pane, t => /utf-8/i.test(t)), 'shell did not start in UTF-8');
    // Box-drawing and accented text: what agent TUIs actually emit. Astral-plane
    // emoji are excluded deliberately - the PowerShell 5.1 console cannot render
    // them regardless of encoding, so testing them would measure conhost, not us.
    pane.write('[char]0x2500 + [char]0x2502 + [char]0x00E9\r');
    assert.ok(await until(pane, t => t.includes('─│é')), 'multi-byte output was mangled');
  });
});

// ConPTY silently drops a resize issued before the child is live.
test('a resize requested before the shell is up still applies', async () => {
  const pane = new Pane({ cols: 80, rows: 24 });
  pane.resize(123, 40); // immediately, before any output
  try {
    await wait(2200);
    // Delimit the value. A bare /\b123\b/ can never match: PSReadLine emits an
    // SGR reset immediately before the output, so the char preceding "123" is
    // the "m" of "\x1b[0m" - a word char, so there is no word boundary there.
    pane.write('"COLS=$($Host.UI.RawUI.WindowSize.Width)"\r');
    assert.ok(await until(pane, t => t.includes('COLS=123')), 'early resize was lost');
  } finally {
    pane.dispose();
  }
});

test('exit code propagates', async () => {
  const pane = new Pane({ cols: 80, rows: 24 });
  await wait(1800);
  const exited = new Promise(res => pane.subscribe((_, e) => e && res(e)));
  pane.write('exit 7\r');
  const e = await Promise.race([exited, wait(6000).then(() => null)]);
  pane.dispose();
  assert.ok(e, 'pane never reported exit');
  assert.equal(e.exitCode, 7);
});

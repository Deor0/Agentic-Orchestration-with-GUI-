import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from '@lydell/node-pty';
import { mode, superviseTree, killTree } from '../src/jobkill.mjs';

const PS = path.join(process.env.SystemRoot ?? 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const wait = ms => new Promise(r => setTimeout(r, ms));
const enc = s => Buffer.from(s, 'utf16le').toString('base64');

/** libuv's uv_kill(pid, 0) just opens the process, so this is a real liveness check. */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(pred, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await wait(100);
  }
  return false;
}

/**
 * PowerShell that launches `script` as a real CreateProcess child.
 * Start-Process would use ShellExecute, which can hand the launch to explorer.exe
 * and so escape the job for reasons that have nothing to do with the code here.
 */
const launch = (script, v) => `
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = '${PS}'
$psi.Arguments = '-NoProfile -EncodedCommand ${enc(script)}'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$${v} = [Diagnostics.Process]::Start($psi)`;

const SLEEPER = 'Start-Sleep -Seconds 600';

/**
 * Root -> middle -> grandchild, where the middle exits straight away. The
 * grandchild is then an orphan: its recorded parent pid is dead, which is what
 * taskkill /T cannot follow. Returns the root script and a reader for the pids.
 */
function orphanTree() {
  const out = path.join(tmpdir(), `jobkill-${randomUUID()}.txt`);
  const middle = `${launch(SLEEPER, 'g')}
Set-Content -LiteralPath '${out}' -Value @($PID, $g.Id)
$g.Dispose()`;
  // Dispose each handle: a live Process object would keep the exited pid
  // resolvable, and the test needs the middle to be genuinely gone.
  const root = `${launch(middle, 'm')}
$m.Dispose()
Start-Sleep -Seconds 600`;

  const pids = () => {
    try {
      const n = readFileSync(out, 'utf8').trim().split(/\r?\n/).map(Number).filter(Boolean);
      return n.length === 2 ? { mid: n[0], grand: n[1] } : null;
    } catch { return null; }
  };
  return { root, pids, cleanup: () => { try { rmSync(out, { force: true }); } catch {} } };
}

/** Wait for the middle to have started the grandchild and then died. */
async function awaitOrphan(pids) {
  assert.ok(await until(() => pids()), 'tree never reported its pids');
  const { mid, grand } = pids();
  assert.ok(await until(() => !alive(mid), 15_000), 'middle process never exited');
  assert.ok(alive(grand), 'grandchild died on its own; the test proves nothing');
  return grand;
}

const strays = new Set();
after(() => { for (const p of strays) { try { process.kill(p); } catch {} } });

test('job objects are actually in use, not the taskkill fallback', () => {
  assert.equal(mode, 'job', 'fell back to taskkill - koffi failed to load');
});

test('killTree kills a grandchild whose parent already exited', async () => {
  const { root, pids, cleanup } = orphanTree();
  const proc = spawn(PS, ['-NoProfile', '-EncodedCommand', enc(root)], {
    windowsHide: true, stdio: 'ignore',
  });
  strays.add(proc.pid);
  try {
    const sup = superviseTree(proc.pid);
    assert.ok(sup, 'superviseTree returned null');
    assert.equal(await sup.ready, true, 'process was not assigned to the job');

    const grand = await awaitOrphan(pids);
    strays.add(grand);

    assert.equal(killTree(proc.pid), true);
    assert.ok(await until(() => !alive(grand), 10_000),
      `orphaned grandchild ${grand} survived killTree`);
  } finally {
    killTree(proc.pid);
    cleanup();
  }
});

test('a PTY shell gets into the job before it can spawn anything', async () => {
  const { root, pids, cleanup } = orphanTree();
  // node-pty reports pid 0 until ConPTY's data pipe is ready, so superviseTree
  // takes the terminal itself and attaches as soon as the pid appears.
  const term = pty.spawn(PS, ['-NoLogo', '-NoProfile', '-EncodedCommand', enc(root)], {
    name: 'xterm-256color', cols: 120, rows: 30, cwd: process.cwd(),
    env: process.env, useConptyDll: true,
  });
  const sup = superviseTree(term);
  // Bundled ConPTY forwards these queries to the terminal; nothing runs until answered.
  term.onData(d => {
    if (d.includes('\u001b[c')) term.write('\u001b[?1;2c');
    if (d.includes('\u001b[6n')) term.write('\u001b[1;1R');
  });
  try {
    assert.equal(await sup.ready, true, 'pty process was not assigned to the job');
    assert.ok(sup.pid > 0, 'never learned the pty pid');
    strays.add(sup.pid);

    const grand = await awaitOrphan(pids);
    strays.add(grand);

    sup.kill();
    assert.ok(await until(() => !alive(grand), 10_000),
      `orphaned grandchild ${grand} survived the job close`);
  } finally {
    sup.kill();
    try { term.kill(); } catch {}
    cleanup();
  }
});

// Why the job object is needed at all: the obvious fix does not work.
test('taskkill /T leaks the same orphaned grandchild', async () => {
  const { root, pids, cleanup } = orphanTree();
  const proc = spawn(PS, ['-NoProfile', '-EncodedCommand', enc(root)], {
    windowsHide: true, stdio: 'ignore',
  });
  strays.add(proc.pid);
  let grand;
  try {
    grand = await awaitOrphan(pids);
    strays.add(grand);
    // proc was never supervised, so this takes killTree's taskkill fallback.
    assert.equal(killTree(proc.pid), true, 'fallback did not even kill the root');
    await wait(1500);
    assert.ok(alive(grand),
      'taskkill /T reached the orphan after all - re-check whether jobkill is still needed');
  } finally {
    if (grand) { try { process.kill(grand); } catch {} }
    cleanup();
  }
});

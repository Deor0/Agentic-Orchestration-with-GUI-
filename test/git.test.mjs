// node --test --test-force-exit "test/git.test.mjs"
//
// Everything here lives in the system temp dir. No test touches this repo, the
// user's repos, or the real C:\wt pen root — the pen root is overridden per test.
//
// Teardown is attached to each test with `t.after`, not to a single root-level
// `after`: --test-force-exit can tear the process down before a root hook has
// finished, and that is how the first draft of this file left 58 throwaway
// repos in %TEMP%. The root `after` below is only a backstop.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  isRepo, createPen, removePen, listPens, sweep, sanitizeSlug, BRANCH_PREFIX,
} from '../src/git.mjs';

// ───────────────────────────── scaffolding + cleanup ───────────────────────────

// os.tmpdir() hands back an 8.3 short path here (C:\Users\OSHANH~1\...) while
// git always prints the real one, so resolve it once up front.
const TMP = realpathSync.native(tmpdir());

const sleep = ms => new Promise(r => setTimeout(r, ms));

const junk = new Set();      // backstop: anything a t.after could not reach
const kids = new Set();      // backstop: child processes still alive

after(async () => {
  for (const c of kids) { try { c.kill(); } catch {} }
  await sleep(300);          // let Windows release the CWDs
  for (const d of junk) nuke(d);
});

function nuke(dir) {
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  junk.delete(dir);
}

const scratch = (tag) => {
  const d = path.join(TMP, `${tag}-${randomUUID().slice(0, 8)}`);
  junk.add(d);
  return d;
};

/** Raw git, deliberately WITHOUT core.longpaths — the long-path test needs it. */
const raw = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** git the way src/git.mjs always runs it. */
const lp = (args, cwd) => raw(['-c', 'core.longpaths=true', ...args], cwd);

// Identity passed per-command: a `git config` call is another ~160 ms process
// on this machine and makeRepo runs for nearly every test.
const WHO = ['-c', 'user.email=pen@test.invalid', '-c', 'user.name=Pen Test', '-c', 'commit.gpgsign=false'];
const commitAll = (msg, repo) => lp([...WHO, 'commit', '-q', '-m', msg], repo);

function makeRepo({ commit = true } = {}) {
  const repo = scratch('penrepo');
  mkdirSync(repo, { recursive: true });
  lp(['init', '-q', '-b', 'main'], repo);
  if (commit) {
    writeFileSync(path.join(repo, 'tracked.txt'), 'hello\n');
    lp(['add', '-A'], repo);
    commitAll('init', repo);
  }
  return repo;
}

/** A live process whose CWD is `dir` — the thing Windows refuses to delete. */
function holdCwd(dir) {
  const c = spawn(process.execPath,
    ['-e', 'process.stdout.write("ready");setInterval(()=>{},1e9)'],
    { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  kids.add(c);
  c.on('exit', () => kids.delete(c));
  return new Promise((res, rej) => {
    c.stdout.once('data', () => res(c));
    c.once('error', rej);
  });
}

/**
 * Kill the holders and wait for them to actually be gone.
 *
 * Do NOT poll `child.exitCode` here: on Windows a child killed with SIGTERM
 * reports `signalCode === 'SIGTERM'` and leaves `exitCode` at null forever, so
 * a loop waiting for exitCode spins until its own timeout — 6.2 s per cycle,
 * which is what made the 20-cycle gate look like a hang.
 */
async function reap(children) {
  const gone = children.map(c => (c.exitCode !== null || c.signalCode !== null)
    ? Promise.resolve()
    : new Promise(res => { c.once('exit', res); try { c.kill(); } catch { res(); } }));
  await Promise.race([Promise.all(gone), sleep(10_000)]);
}

/** A throwaway repo, a pen root, and teardown that runs even if the test fails. */
function lab(t, opts) {
  const repo = makeRepo(opts);
  const root = scratch('wt');
  const mine = [];
  t.after(async () => { await reap(mine); nuke(root); nuke(repo); });
  return {
    repo, root,
    hold: async dir => { const c = await holdCwd(dir); mine.push(c); return c; },
    stop: async child => { await reap([child]); },
  };
}

// ──────────────────────────────────── tests ───────────────────────────────────

test('isRepo: true inside a work tree, false outside, false for a missing path', async (t) => {
  const { repo } = lab(t);
  const plain = scratch('notrepo');
  mkdirSync(plain, { recursive: true });
  t.after(() => nuke(plain));

  assert.equal(await isRepo(repo), true);
  assert.equal(await isRepo(path.join(repo, 'sub-does-not-exist')), false);
  assert.equal(await isRepo(plain), false);
  assert.equal(await isRepo(undefined), false);
});

// Rule 10: slugs that Windows cannot store, or git cannot name a branch.
test('sanitizeSlug: illegal characters, reserved device names, trailing dot/space', () => {
  assert.equal(sanitizeSlug('fix<>:"|?*bug'), 'fix-bug');
  assert.equal(sanitizeSlug('feat/login'), 'feat-login');
  assert.equal(sanitizeSlug('back\\slash'), 'back-slash');
  assert.equal(sanitizeSlug('trailing. '), 'trailing');
  assert.equal(sanitizeSlug('dots..here'), 'dots-here');          // '..' is an illegal refname
  assert.equal(sanitizeSlug('spa ced'), 'spa-ced');
  assert.equal(sanitizeSlug('feature.lock'), 'feature-lock');     // refs/heads/x.lock is not a branch
  for (const r of ['CON', 'con', 'PRN', 'NUL', 'AUX', 'COM1', 'LPT1', 'nul.txt']) {
    assert.match(sanitizeSlug(r), /-pen$/, `${r} must not stay a device name`);
  }
  assert.throws(() => sanitizeSlug('???'), /no usable characters/);
  assert.throws(() => sanitizeSlug(''), /no usable characters/);
});

test('createPen: short root, cult/ branch off HEAD, tracked files present', async (t) => {
  const { repo, root } = lab(t);
  const pen = await createPen({ repo, slug: 'alpha', root });

  assert.equal(pen.path, path.win32.resolve(root, 'alpha'));
  assert.equal(pen.branch, `${BRANCH_PREFIX}alpha`);
  assert.equal(pen.slug, 'alpha');
  assert.ok(existsSync(path.join(pen.path, 'tracked.txt')), 'tracked file was not checked out');
  assert.equal(lp(['rev-parse', 'HEAD'], pen.path), lp(['rev-parse', 'HEAD'], repo),
    'pen must branch from the repo HEAD');

  const pens = await listPens(repo);
  assert.equal(pens.length, 2);
  assert.ok(pens.some(w => w.path.toLowerCase() === pen.path.toLowerCase() && w.branch === pen.branch));
});

// Rule 10: an illegal slug must produce a usable pen, not an error.
test('createPen: a reserved name and illegal characters still produce a pen', async (t) => {
  const { repo, root } = lab(t);

  const con = await createPen({ repo, slug: 'CON', root });
  assert.equal(path.basename(con.path), 'CON-pen');
  assert.ok(existsSync(con.path));

  const nasty = await createPen({ repo, slug: 'fix: the <thing>? ', root });
  assert.equal(path.basename(nasty.path), 'fix-the-thing');
  assert.ok(existsSync(nasty.path));
  assert.equal(nasty.branch, `${BRANCH_PREFIX}fix-the-thing`);
});

test('createPen: an existing branch name, and an existing directory, both get out of the way', async (t) => {
  const { repo, root } = lab(t);
  lp(['branch', `${BRANCH_PREFIX}beta`], repo);           // branch already taken
  mkdirSync(path.join(root, 'beta'), { recursive: true }); // directory already taken

  const pen = await createPen({ repo, slug: 'beta', root });
  assert.equal(pen.branch, `${BRANCH_PREFIX}beta-2`);
  assert.equal(path.basename(pen.path), 'beta-2');
  assert.ok(existsSync(path.join(pen.path, 'tracked.txt')));
});

test('createPen: detached HEAD still branches from the current commit', async (t) => {
  const { repo, root } = lab(t);
  const head = lp(['rev-parse', 'HEAD'], repo);
  lp(['checkout', '-q', '--detach'], repo);

  const pen = await createPen({ repo, slug: 'detached', root });
  assert.equal(lp(['rev-parse', 'HEAD'], pen.path), head);
});

test('createPen: a repo with no commits fails with an actionable message, it does not hang', async (t) => {
  const { repo, root } = lab(t, { commit: false });
  await assert.rejects(createPen({ repo, slug: 'empty', root }),
    /no commits yet.*git commit --allow-empty/s);
});

test('createPen: a path that is not a repo fails fast', async (t) => {
  const plain = scratch('notrepo');
  mkdirSync(plain, { recursive: true });
  t.after(() => nuke(plain));
  await assert.rejects(createPen({ repo: plain, slug: 'x', root: scratch('wt') }),
    /not a git work tree/);
});

// Rule 12.
test('createPen: a submodule repo is refused, not half-built', async (t) => {
  const { repo, root } = lab(t);
  writeFileSync(path.join(repo, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = ../x\n');
  lp(['add', '.gitmodules'], repo);
  commitAll('add submodule config', repo);

  await assert.rejects(createPen({ repo, slug: 'sub', root }), /submodules.*out of scope/s);
  assert.equal(existsSync(path.join(root, 'sub')), false, 'nothing may be left behind');
});

// Rule 8.
test('createPen: warns when two tracked paths differ only in case', async (t) => {
  const { repo, root } = lab(t);
  // Both names cannot exist on disk here, so put them in the index directly.
  const blob = lp(['hash-object', '-w', 'tracked.txt'], repo);
  lp(['update-index', '--add', '--cacheinfo', `100644,${blob},Readme.md`], repo);
  lp(['update-index', '--add', '--cacheinfo', `100644,${blob},README.md`], repo);
  commitAll('case clash', repo);

  const pen = await createPen({ repo, slug: 'caseclash', root });
  assert.ok(existsSync(pen.path), 'a case clash must warn, never fail the create');
  assert.ok(pen.warnings.some(w => /differ only in case/i.test(w) && /readme\.md/i.test(w)),
    `expected a case-collision warning, got ${JSON.stringify(pen.warnings)}`);
});

// Rule 6.
test('.worktreeinclude copies the listed gitignored paths and nothing else', async (t) => {
  const { repo, root } = lab(t);
  writeFileSync(path.join(repo, '.gitignore'), '.env\nsecret.txt\nconf/\n');
  writeFileSync(path.join(repo, '.env'), 'TOKEN=1\n');
  writeFileSync(path.join(repo, 'secret.txt'), 'do not copy me\n');
  mkdirSync(path.join(repo, 'conf'), { recursive: true });
  writeFileSync(path.join(repo, 'conf', 'app.local.json'), '{}');
  writeFileSync(path.join(repo, 'conf', 'other.json'), '{}');
  writeFileSync(path.join(repo, '.worktreeinclude'),
    '# gitignored files the agent still needs\n\n.env\nconf/*.local.json\nnope.txt\n');
  lp(['add', '-A'], repo);
  commitAll('ignore rules', repo);

  const pen = await createPen({ repo, slug: 'inc', root });

  assert.ok(existsSync(path.join(pen.path, '.env')), '.env was not copied');
  assert.ok(existsSync(path.join(pen.path, 'conf', 'app.local.json')), 'glob match was not copied');
  assert.equal(existsSync(path.join(pen.path, 'secret.txt')), false,
    'an unlisted gitignored file must not be copied');
  assert.equal(existsSync(path.join(pen.path, 'conf', 'other.json')), false,
    'a non-matching sibling must not be copied');
  assert.ok(pen.warnings.some(w => /nothing matched "nope.txt"/.test(w)),
    'a pattern that matches nothing must be reported');
  assert.deepEqual([...pen.copied].sort(), ['.env', 'conf/app.local.json']);
});

// Rule 1 — the flag is not cargo cult; this test is the evidence.
test('core.longpaths: worktree add fails without the flag and succeeds with it', async (t) => {
  const { repo, root } = lab(t);
  mkdirSync(root, { recursive: true });

  // ~250 chars of tracked path. Node reaches it via \\?\ prefixing; git needs
  // core.longpaths because it uses the plain Win32 API with MAX_PATH.
  const seg = 'a'.repeat(40);
  const deep = path.join(seg, seg, seg, seg, seg, `${'f'.repeat(40)}.txt`);
  mkdirSync(path.dirname(path.join(repo, deep)), { recursive: true });
  writeFileSync(path.join(repo, deep), 'deep\n');
  lp(['add', '-A'], repo);
  commitAll('deep file', repo);

  const control = path.win32.resolve(root, 'nolp');
  assert.ok(control.length + 1 + deep.length > 260,
    `test is pointless unless the checkout path exceeds MAX_PATH (got ${control.length + 1 + deep.length})`);

  let failed = null;
  try {
    raw(['-c', 'core.longpaths=false', 'worktree', 'add', '-b', 'nolp', control, 'HEAD'], repo);
  } catch (e) {
    failed = `${e.stderr ?? ''}${e.stdout ?? ''}`;
  }
  lp(['worktree', 'prune'], repo);
  nuke(control);

  assert.ok(failed, 'git 2.55 checked out a >260 char path WITHOUT core.longpaths — rule W1 may be obsolete');
  assert.match(failed, /too long|unable to create|cannot create/i);

  // Same repo, same depth, through our helper: must work.
  const pen = await createPen({ repo, slug: 'lp', root });
  assert.ok(existsSync(path.join(pen.path, deep)), 'core.longpaths=true did not rescue the checkout');
});

// Rule 4 — the ordinary case: nothing is sitting in the pen, so the atomic
// rename-aside runs and the pen path is free the instant removePen returns.
test('removePen renames the pen aside, prunes, then deletes in the background', async (t) => {
  const { repo, root } = lab(t);
  const pen = await createPen({ repo, slug: 'quiet', root });

  const res = await removePen({ repo, path: pen.path });
  assert.equal(res.renamed, true, 'the pen must be moved aside, not deleted in place');
  assert.equal(path.dirname(res.trash).toLowerCase(), path.win32.resolve(root).toLowerCase(),
    'the trash must stay in the same parent, i.e. the same volume');
  assert.equal(existsSync(pen.path), false, 'the pen path must be free immediately');
  assert.equal(res.pruned, true);
  assert.equal((await listPens(repo)).length, 1, 'git bookkeeping must be pruned');
  assert.equal(await res.purge, true);
  assert.equal(existsSync(res.trash), false);
});

// Rule 4 — the EBUSY case, and the measured correction to SPEC W3.
test('removePen works while a live process holds the pen as its CWD', async (t) => {
  const { repo, root, hold, stop } = lab(t);
  const pen = await createPen({ repo, slug: 'busy', root });
  const child = await hold(pen.path);

  // Baseline 1: a plain delete is what every naive implementation tries.
  let rmCode = null;
  try { rmSync(pen.path, { recursive: true, force: true }); } catch (e) { rmCode = e.code; }
  assert.ok(rmCode, 'Windows allowed deleting a live CWD — rule W3 would be obsolete');

  // Baseline 2: SPEC W3 claims "a rename succeeds where a delete fails". On
  // Windows 11 26300 that is FALSE for the CWD case — renaming the directory
  // fails too. This assertion is the evidence; if it ever starts passing,
  // Windows changed and removePen can drop its empty-in-place fallback.
  let mvCode = null;
  try { renameSync(pen.path, pen.path + '-probe'); } catch (e) { mvCode = e.code; }
  assert.ok(mvCode, 'renaming a live CWD now succeeds — simplify removePen');

  const res = await removePen({ repo, path: pen.path });
  assert.equal(res.renamed, false, 'rename cannot work here; the fallback must have run');
  assert.equal(res.emptied, true, 'the pen must be emptied in place');
  assert.deepEqual(readdirSync(pen.path), [], "the agent's files must all be gone");
  assert.equal(res.pruned, true);
  assert.equal((await listPens(repo)).length, 1, 'git bookkeeping must be pruned');

  await stop(child);                              // the caller's jobkill, simulated
  assert.equal(await res.purge, true, 'the empty husk must go once the holder dies');
  assert.equal(existsSync(pen.path), false);
});

test('removePen: stopWatchers runs first, and a throwing watcher cannot strand the pen', async (t) => {
  const { repo, root } = lab(t);
  const pen = await createPen({ repo, slug: 'watched', root });

  let calledWith = null;
  const res = await removePen({
    repo, path: pen.path,
    stopWatchers: p => { calledWith = p; throw new Error('watcher refused to stop'); },
  });
  assert.equal(calledWith.toLowerCase(), pen.path.toLowerCase());
  assert.equal(res.renamed, true);
  assert.equal(await res.purge, true);
});

// Rule 7.
test('sweep finds a stranded directory, reports it, and deletes nothing', async (t) => {
  const { repo, root } = lab(t);
  const pen = await createPen({ repo, slug: 'stranded', root });
  const other = await createPen({ repo, slug: 'healthy', root });

  // Exactly what `git worktree remove` does before it deletes the files:
  // drop the bookkeeping. If it dies here, the directory is invisible to git.
  rmSync(path.join(repo, '.git', 'worktrees', 'stranded'), { recursive: true, force: true });
  assert.equal((await listPens(repo)).length, 2, 'stranded pen should now be invisible to git');

  // An unrelated directory in the same root must not be reported.
  mkdirSync(path.join(root, 'someones-notes'), { recursive: true });
  writeFileSync(path.join(root, 'someones-notes', 'todo.txt'), 'mine\n');

  const strays = await sweep(repo, { root });
  assert.deepEqual(strays.map(s => path.basename(s.path)), ['stranded']);
  assert.equal(strays[0].kind, 'stray');
  assert.ok(existsSync(pen.path), 'sweep must not delete anything');
  assert.ok(existsSync(path.join(root, 'someones-notes', 'todo.txt')));
  assert.ok(existsSync(other.path));

  // Reclamation is removePen on the stray — no second code path.
  const res = await removePen({ repo, path: strays[0].path });
  assert.equal(await res.purge, true);
  assert.deepEqual(await sweep(repo, { root }), []);
});

// Rule 5.
test('concurrent createPen calls on one repo do not corrupt .git', async (t) => {
  const { repo, root } = lab(t);

  const pens = await Promise.all(
    Array.from({ length: 6 }, (_, i) => createPen({ repo, slug: `par${i}`, root })));

  const paths = new Set(pens.map(p => p.path.toLowerCase()));
  const branches = new Set(pens.map(p => p.branch));
  assert.equal(paths.size, 6, 'two pens claimed the same directory');
  assert.equal(branches.size, 6, 'two pens claimed the same branch');
  for (const p of pens) assert.ok(existsSync(path.join(p.path, 'tracked.txt')));

  const listed = await listPens(repo);
  assert.equal(listed.length, 7, 'git worktree list disagrees with what we created');
  assert.equal(existsSync(path.join(repo, '.git', 'index.lock')), false, 'a stale index.lock was left behind');
  lp(['fsck', '--no-progress', '--no-dangling'], repo);   // throws if .git is corrupt
});

// Rule 5, the collision the queue exists to prevent: the same slug, six times
// at once, must produce six distinct pens rather than six racing worktree adds.
test('concurrent createPen with one slug hands out distinct pens', async (t) => {
  const { repo, root } = lab(t);
  const pens = await Promise.all(
    Array.from({ length: 6 }, () => createPen({ repo, slug: 'samename', root })));
  assert.equal(new Set(pens.map(p => p.path.toLowerCase())).size, 6);
  assert.equal(new Set(pens.map(p => p.branch)).size, 6);
});

// THE GATE (SPEC §5): 20 create/remove cycles with an agent in each pen.
test('gate: 20 create/remove cycles with a live CWD holder leave nothing stranded', async (t) => {
  const { repo, root, hold, stop } = lab(t);

  for (let i = 0; i < 20; i++) {
    const pen = await createPen({ repo, slug: `lamb-${i}`, root });
    assert.ok(existsSync(path.join(pen.path, 'tracked.txt')), `cycle ${i}: pen not checked out`);

    const child = await hold(pen.path);                    // the agent, sitting in its pen
    const res = await removePen({ repo, path: pen.path });
    assert.ok(res.renamed || res.emptied, `cycle ${i}: pen content was not released`);
    assert.equal(res.pruned, true, `cycle ${i}: git bookkeeping was not pruned`);

    await stop(child);                                     // caller kills the tree (jobkill.mjs)
    assert.equal(await res.purge, true, `cycle ${i}: trash was never reclaimed`);
  }

  // Zero stranded directories.
  assert.deepEqual(readdirSync(root), [], 'pen root must be empty after 20 cycles');
  assert.deepEqual(await sweep(repo, { root }), []);

  // git worktree list matches what is actually on disk.
  const listed = await listPens(repo);
  assert.equal(listed.length, 1, `git still lists ${listed.length} worktrees: ${listed.map(w => w.path)}`);
  assert.ok(existsSync(listed[0].path));
  assert.equal(listed[0].path.toLowerCase(), path.win32.resolve(repo).toLowerCase());
  // prune removes the whole directory once the last entry goes.
  const book = path.join(repo, '.git', 'worktrees');
  assert.deepEqual(existsSync(book) ? readdirSync(book) : [], [],
    'stale worktree bookkeeping survived');
});

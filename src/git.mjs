// Git worktree layer: one worktree ("pen") per agent ("lamb"), Windows-correct.
//
// Every rule in SPEC §5 (W1-W12) is a filed bug in a shipping competitor, so the
// comments here say *why*, not what. The short version:
//
//   W1  every git call goes through gitRun(), which always prepends
//       `-c core.longpaths=true`. There is no other way to run git in this file.
//   W2  🔴 NEVER create a directory junction inside a pen. See the banner below.
//   W3  removePen() renames aside before it deletes; see that function.
//   W10 every mutating command goes through withRepoLock(). Reads do not.
//
// ──────────────────────────────────────────────────────────────────────────────
// 🔴 W2 — DO NOT CREATE JUNCTIONS INSIDE A PEN. DO NOT DOCUMENT DOING SO.
//
// `mklink /J <pen>\node_modules <main>\node_modules` looks like a free way to
// share dependencies. It is not. `git worktree remove --force` walks into a
// directory junction and recursively deletes the *far side* — it has emptied a
// main checkout's node_modules. Node's fs.rm(recursive) has the same shape of
// hazard. If dependency sharing is ever wanted here it must be pnpm's content-
// addressed store (hard links to files, never a directory reparse point), or
// nothing. There is deliberately no helper in this module that creates one.
// ──────────────────────────────────────────────────────────────────────────────
//
// Precondition on removePen(): the CALLER must have already killed the agent's
// process tree (src/jobkill.mjs owns that). This module deliberately does not
// import it. Removal still works if a process is sitting in the pen — that is
// what the rename-aside step buys — but the directory cannot actually be freed
// until the process is gone.

import { execFile } from 'node:child_process';
import { constants as FS, promises as fsp } from 'node:fs';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** W1/W2: pens live in a short root. core.longpaths fixes Git, and only Git —
 *  Node, npm, MSBuild and Explorer still break past 260 chars, so the root has
 *  to be short on its own merits. Configurable, but never a deep sibling of the
 *  repo (which is how competitors hit "Filename too long" in the first place). */
export const PEN_ROOT = process.env.ORCH_PEN_ROOT ?? 'C:\\wt';

export const BRANCH_PREFIX = 'cult/';

/** W11: gitignored files git refuses to carry into a new worktree. */
export const INCLUDE_FILE = '.worktreeinclude';

const TRASH_PREFIX = '.trash-';

/** W1/W11: a git invocation that hangs forever is Orca's headline Windows bug. */
const DEFAULT_TIMEOUT_MS = 60_000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ───────────────────────────── the one git entry point ─────────────────────────

/**
 * W1: the single door every git call goes through, so core.longpaths can never
 * be forgotten. Per-command (`-c`), so no admin rights and the user's global
 * config is never touched — the registry's LongPathsEnabled does not cover Git.
 *
 * W6/W9: output is captured as bytes and decoded UTF-8 explicitly; git's own
 * path quoting is disabled so non-ASCII paths come back verbatim. Nothing is
 * ever written to git's stdin, so there is no chance of sending `\r\n` (W5).
 *
 * @returns {Promise<{ code:number, stdout:string, stderr:string }>}
 */
function gitRun(args, { cwd, timeout = DEFAULT_TIMEOUT_MS, check = true } = {}) {
  const argv = ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args];
  return new Promise((resolve, reject) => {
    execFile('git', argv, {
      cwd,
      timeout,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      // GIT_TERMINAL_PROMPT=0 turns "waiting for a credential you will never
      // type" into an immediate error. W11: fail loudly, never hang.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }, (err, stdoutBuf, stderrBuf) => {
      const stdout = Buffer.from(stdoutBuf ?? '').toString('utf8');
      const stderr = Buffer.from(stderrBuf ?? '').toString('utf8');
      const where = cwd ? ` in ${cwd}` : '';
      if (err?.killed || err?.signal) {
        return reject(new Error(
          `git ${args.join(' ')} timed out after ${timeout}ms${where}. ` +
          `The process was killed; nothing is hanging, but the repo may need a ` +
          `'git worktree prune'. stderr: ${stderr.trim() || '(none)'}`));
      }
      if (err && typeof err.code !== 'number') {
        return reject(new Error(`could not run git${where}: ${err.message}`));
      }
      const code = err?.code ?? 0;
      if (code !== 0 && check) {
        return reject(new Error(
          `git ${args.join(' ')} failed (exit ${code})${where}: ` +
          `${(stderr.trim() || stdout.trim() || '(no output)')}`));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

const out = r => r.stdout.trim();

// ───────────────────────────── per-repo mutation queue ─────────────────────────

const queues = new Map();

/**
 * W10: N pens still contend on one shared `.git` — `worktree add`, `prune` and
 * ref creation all take index.lock / worktrees bookkeeping, and concurrent
 * callers lose with "Unable to create '...index.lock': File exists". Reads are
 * not serialized; they do not take the lock.
 *
 * shortcut: the queue key is the resolved, lowercased repo path, not the git
 * common dir — two different paths to the same repo (a symlink, or a pen used
 * as `repo`) would get separate queues. Upgrade to `rev-parse --git-common-dir`
 * if pens ever spawn pens.
 */
function withRepoLock(repo, fn) {
  const key = path.resolve(repo).toLowerCase();
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);           // run even if the previous op threw
  queues.set(key, next.then(() => {}, () => {}));
  return next;
}

// ───────────────────────────────── slug hygiene ────────────────────────────────

// W10: device names are reserved in *every* directory on Windows, extension and
// case irrelevant: C:\wt\con\ cannot be created and the error is unhelpful.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Make a slug safe as both a Windows directory name and a git ref component.
 * The intersection of the two rulesets is narrow, so take it whole: anything
 * outside [A-Za-z0-9._-] becomes '-'. That covers <>:"|?* and path separators
 * (Windows) plus space ~ ^ : ? * [ \ (git refs) in one pass.
 */
export function sanitizeSlug(slug) {
  let s = String(slug ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);
  s = s.replace(/\.{2,}/g, '-');                      // '..' is path traversal and an illegal refname
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/^[-.]+/, '').replace(/[-. ]+$/, ''); // Windows silently strips a trailing dot/space
  if (/\.lock$/i.test(s)) s = `${s.slice(0, -5)}-lock`;   // refs/heads/x.lock is not a branch
  if (RESERVED.test(s.split('.')[0])) s = `${s}-pen`;
  if (!s) throw new Error(`slug ${JSON.stringify(slug)} contains no usable characters`);
  return s;
}

// ──────────────────────────────── repo inspection ──────────────────────────────

/** Is `dir` inside a git work tree? Never throws. */
export async function isRepo(dir) {
  if (!dir) return false;
  try {
    const r = await gitRun(['rev-parse', '--is-inside-work-tree'],
      { cwd: dir, check: false, timeout: 15_000 });
    return r.code === 0 && out(r) === 'true';
  } catch { return false; }
}

/** `git worktree list` — what git believes exists, main worktree included. */
export async function listPens(repo) {
  const r = await gitRun(['worktree', 'list', '--porcelain'], { cwd: repo });
  const pens = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    const t = line.replace(/\r$/, '');
    if (t.startsWith('worktree ')) {
      cur = { path: real(t.slice(9)), head: null, branch: null, detached: false, locked: false, prunable: false };
      pens.push(cur);
    } else if (!cur) continue;
    else if (t.startsWith('HEAD ')) cur.head = t.slice(5);
    else if (t.startsWith('branch ')) cur.branch = t.slice(7).replace(/^refs\/heads\//, '');
    else if (t === 'detached') cur.detached = true;
    else if (t.startsWith('locked')) cur.locked = true;
    else if (t.startsWith('prunable')) cur.prunable = true;
  }
  return pens;
}

const same = (a, b) => path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase();

/**
 * Git prints the *real* path of a worktree, so a caller who passes an 8.3 short
 * path (`C:\Users\OSHANH~1\...`, which is what os.tmpdir() hands back) or a
 * junction would never match git's own output. Everything compared against git
 * goes through here first.
 */
const real = p => {
  try { return path.win32.resolve(realpathSync.native(p)); }
  catch { return path.win32.resolve(p); }
};

async function hasCommits(repo) {
  const r = await gitRun(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: repo, check: false });
  return r.code === 0;
}

async function branchExists(repo, branch) {
  const r = await gitRun(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, check: false });
  return r.code === 0;
}

async function trackedFiles(repo) {
  const r = await gitRun(['ls-files', '-z'], { cwd: repo });
  return r.stdout.split('\0').filter(Boolean);
}

/**
 * W12: two tracked paths differing only in case cannot both exist on a
 * case-insensitive filesystem — one silently overwrites the other and the
 * worktree is dirty the moment it is created. Warn, never fail: the repo is
 * already like this and refusing to make a pen helps nobody.
 */
function caseCollisions(files) {
  const seen = new Map();
  const clashes = [];
  for (const f of files) {
    const k = f.toLowerCase();
    const first = seen.get(k);
    if (first === undefined) seen.set(k, f);
    else clashes.push([first, f]);
  }
  return clashes;
}

// ──────────────────────────────── create a pen ─────────────────────────────────

/**
 * Create a worktree on a fresh branch off the repo's current HEAD.
 *
 * @param {object} o
 * @param {string} o.repo       path inside the repo
 * @param {string} o.slug       human name; sanitized for Windows and for refs
 * @param {string} [o.root]     pen root, default PEN_ROOT (short, on purpose)
 * @param {string} [o.branch]   override the `cult/<slug>` branch name
 * @param {string} [o.start]    start point, default HEAD (works when detached)
 * @param {boolean} [o.include] honour .worktreeinclude, default true
 * @returns {Promise<{path:string, branch:string, slug:string, warnings:string[], copied:string[]}>}
 */
export async function createPen({ repo, slug, root = PEN_ROOT, branch, start = 'HEAD', include = true, timeout } = {}) {
  const safe = sanitizeSlug(slug);
  const warnings = [];

  // One rev-parse answers three questions — is it a repo, where is its root,
  // does the start point resolve. A git process costs ~160 ms on a Windows box
  // with Defender on, and createPen is in the hot path of the 20-cycle gate.
  let probe;
  try { probe = await gitRun(['rev-parse', '--show-toplevel', start], { cwd: repo, check: false, timeout }); }
  catch (err) { throw new Error(`not a git work tree: ${repo} (${err.message})`); }
  const top = out(probe).split('\n')[0]?.trim();
  if (!top || !/^[A-Za-z]:/.test(top)) throw new Error(`not a git work tree: ${repo}`);
  const repoRoot = real(top);

  if (probe.code !== 0) {
    if (start === 'HEAD') {
      throw new Error(
        `repo ${repoRoot} has no commits yet, so there is nothing to branch from. ` +
        `Make one commit (git commit --allow-empty -m init) and retry.`);
    }
    throw new Error(`start point "${start}" does not resolve in ${repoRoot}`);
  }

  // W12 (out of scope, refuse cleanly): a submodule-heavy repo produces a pen
  // with empty submodule directories and a build that fails in a way nobody
  // can read. Better a clear refusal than a broken pen.
  if (existsSync(path.join(repoRoot, '.gitmodules'))) {
    throw new Error(
      `repo ${repoRoot} uses submodules (.gitmodules present). Submodule-heavy ` +
      `repos are out of scope for worktree pens: 'git worktree add' leaves every ` +
      `submodule empty. Use a full clone for this repo instead.`);
  }

  const files = await trackedFiles(repo);
  for (const [a, b] of caseCollisions(files)) {
    warnings.push(`tracked paths differ only in case and cannot coexist on this filesystem: ${a} / ${b}`);
  }

  await fsp.mkdir(root, { recursive: true });
  const penRoot = real(root);

  // W10: picking a free path + branch and claiming them must be one atomic step,
  // or two concurrent createPen calls pick the same name.
  const picked = await withRepoLock(repo, async () => {
    const penPath = await freePath(penRoot, safe);
    const branchName = await freeBranch(repo, branch ?? `${BRANCH_PREFIX}${safe}`);
    await gitRun(['worktree', 'add', '-b', branchName, penPath, start], { cwd: repo, timeout });
    return { path: penPath, branch: branchName };
  });

  const copied = include ? await copyIncludes(repoRoot, picked.path, warnings) : [];
  return { ...picked, slug: safe, warnings, copied };
}

/** W2 (root must stay short) + collision: C:\wt\slug, then slug-2, slug-3... */
async function freePath(root, safe) {
  for (let n = 1; n <= 500; n++) {
    const p = path.win32.resolve(root, n === 1 ? safe : `${safe}-${n}`);
    if (!existsSync(p)) return p;
  }
  throw new Error(`no free pen directory under ${root} for slug "${safe}" after 500 tries`);
}

/** A branch name that already exists is a normal collision, not an error. */
async function freeBranch(repo, wanted) {
  for (let n = 1; n <= 500; n++) {
    const b = n === 1 ? wanted : `${wanted}-${n}`;
    if (!await branchExists(repo, b)) return b;
  }
  throw new Error(`no free branch name based on "${wanted}" after 500 tries`);
}

// ───────────────────────────── .worktreeinclude (W11) ──────────────────────────

/**
 * W11: `git worktree add` checks out tracked files only, so `.env`, local
 * settings and build caches do not come along and the agent's first build fails
 * for a reason that looks nothing like the cause.
 *
 * `.worktreeinclude` at the repo root lists gitignored paths to copy into a new
 * pen, one per line, `#` comments, blank lines ignored.
 *
 * shortcut: this is NOT gitignore syntax. Supported, deliberately: a literal
 * relative path (file or directory, copied recursively) and simple globs via
 * node:fs glob (`*.env`, `conf/*.local.json`). NOT supported: `!` negation,
 * leading `/`, trailing `/` semantics, `**` anchoring rules, or dotfile
 * matching by a bare `*`. A pattern that matches nothing is reported as a
 * warning rather than failing the create. Upgrade only if someone actually
 * needs negation — reimplementing gitignore for a copy list is not worth it.
 */
async function copyIncludes(repoRoot, penPath, warnings) {
  let text;
  try { text = await fsp.readFile(path.join(repoRoot, INCLUDE_FILE), 'utf8'); }
  catch { return []; }

  const copied = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) { warnings.push(`${INCLUDE_FILE}: '!' negation is not supported, ignoring "${line}"`); continue; }
    const pattern = line.replace(/^[/\\]+/, '').replace(/\\/g, '/').replace(/\/+$/, '');

    let matches = [];
    if (/[*?[\]]/.test(pattern)) {
      for await (const m of fsp.glob(pattern, { cwd: repoRoot })) matches.push(m);
    } else if (existsSync(path.join(repoRoot, pattern))) {
      matches = [pattern];
    }
    if (!matches.length) { warnings.push(`${INCLUDE_FILE}: nothing matched "${line}"`); continue; }

    for (const rel of matches) {
      const src = path.win32.resolve(repoRoot, rel);
      // A pattern must not reach outside the repo; `..` is already stripped by
      // the glob, but a literal line is whatever the user typed.
      if (!src.toLowerCase().startsWith(repoRoot.toLowerCase() + path.win32.sep)) {
        warnings.push(`${INCLUDE_FILE}: "${line}" resolves outside the repo, ignoring`);
        continue;
      }
      const dst = path.win32.resolve(penPath, path.relative(repoRoot, src));
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      // W2: `cp` would happily follow a junction. verbatimSymlinks keeps links
      // as links instead of duplicating (or chasing) whatever they point at.
      await fsp.cp(src, dst, { recursive: true, force: true, verbatimSymlinks: true });
      copied.push(path.relative(repoRoot, src).replace(/\\/g, '/'));
    }
  }
  return copied;
}

// ──────────────────────────────── remove a pen ─────────────────────────────────

/**
 * W3 — removal order, and the order is the whole point.
 *
 *   0. (caller) kill the agent's process tree — src/jobkill.mjs, NOT us.
 *   1. stop watchers, so nothing re-opens a handle underneath us.
 *   2. RENAME the directory aside, on the same volume — atomic, and it frees
 *      the pen path instantly even when a watcher or antivirus still holds a
 *      handle inside it.
 *
 *      ⚠️ MEASURED CORRECTION TO SPEC W3. The spec says "a rename succeeds
 *      where a delete fails". That is true for an ordinary open handle. It is
 *      NOT true for the case the spec actually cares about: on Windows 11
 *      (26300) renaming a directory that is a live process's CWD fails with
 *      EBUSY, exactly as deleting it fails with EPERM — and so does renaming
 *      any ancestor of that CWD. Verified with fs.rename and with cmd `move`.
 *      What *does* work is deleting the directory's contents, as long as the
 *      entry being deleted is not itself on the CWD chain.
 *
 *      So step 2 falls back to emptying the pen in place. The agent's files
 *      and the worktree's `.git` link go immediately; what survives is an
 *      empty husk directory, which step 4 retries until the holder exits.
 *   3. `git worktree prune`, so git's bookkeeping matches disk. Note that
 *      `git worktree remove` does the opposite — it drops bookkeeping *before*
 *      deleting files, which is exactly how a directory ends up stranded and
 *      invisible to `git worktree list`. We never call it.
 *   4. delete the renamed folder in the background, tolerating failure. If a
 *      process is still in there, the trash directory simply waits; sweep()
 *      will find it later.
 *
 * @returns {Promise<{ renamed:boolean, emptied:boolean, trash:string|null,
 *                     pruned:boolean, purge:Promise<boolean> }>}
 *          `renamed` false + `emptied` true means the CWD case above: the pen
 *          path still exists but is empty. `purge` resolves true/false when the
 *          background delete finishes; it never rejects. Await it in tests,
 *          ignore it in production.
 */
export async function removePen({ repo, path: penPath, stopWatchers, timeout } = {}) {
  if (!penPath) throw new Error('removePen needs a pen path');
  const target = real(penPath);

  // 1. watchers. Best effort: a watcher that refuses to stop must not strand
  //    the pen, which is the failure this whole function exists to avoid.
  if (typeof stopWatchers === 'function') {
    try { await stopWatchers(target); } catch { /* best effort, step 2 copes */ }
  }

  // 2. rename aside, inside the same parent so it is guaranteed same-volume.
  let trash = null;
  let renamed = false;
  let emptied = false;
  if (existsSync(target)) {
    const aside = path.win32.join(path.dirname(target),
      `${TRASH_PREFIX}${path.basename(target)}-${randomUUID().slice(0, 8)}`);
    try {
      await fsp.rename(target, aside);
      renamed = true;
      trash = aside;
    } catch (err) {
      if (!BUSY.has(err.code)) {
        throw Object.assign(new Error(
          `could not move pen aside: ${target} -> ${aside} (${err.code ?? err.message})`),
          { cause: err });
      }
      // The CWD case — see the measured note above. Empty it instead.
      trash = target;
      emptied = await emptyDir(target);
    }
  }

  // 3. git bookkeeping now matches disk.
  let pruned = false;
  if (repo) {
    await withRepoLock(repo, async () => {
      await gitRun(['worktree', 'prune'], { cwd: repo, timeout });
      pruned = true;
    });
  }

  // 4. background delete. Retries, because the holding process usually dies a
  //    moment later; never rejects, because a leftover trash dir is a sweep()
  //    problem, not an error the caller can act on.
  const purge = trash ? purgeDir(trash) : Promise.resolve(true);
  purge.catch(() => {});
  return { renamed, emptied, trash, pruned, purge };
}

/** Windows codes for "something still has this open". */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);

/** Delete everything inside `dir`, tolerating entries that are themselves held
 *  (a subdirectory can be a process's CWD too). Returns true if the dir is now
 *  empty — which is as far as Windows will let us get while it is a live CWD. */
async function emptyDir(dir) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return false; }
  for (const e of entries) {
    try { await fsp.rm(path.join(dir, e), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch { /* held; purgeDir retries the whole tree later */ }
  }
  try { return (await fsp.readdir(dir)).length === 0; } catch { return true; }
}

async function purgeDir(dir, attempts = 24, delayMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch { await sleep(delayMs); }
  }
  return false;
}

// ─────────────────────────────────── sweep ─────────────────────────────────────

/**
 * W3, the other half: find directories under the pen root that belong to this
 * repo but that git no longer knows about — stranded pens, and trash left by a
 * removePen whose background delete could not finish.
 *
 * Reports only. Nothing here deletes anything: the pen root can contain pens
 * for other repos and directories the user made by hand. Reclaim a stray with
 * `removePen({ repo, path: stray.path })`.
 *
 * shortcut: a stray is identified by its `.git` file pointing back at this
 * repo, which is what keeps unrelated directories out of the list. The one
 * thing that escapes it is the *empty husk* left by removePen's CWD fallback —
 * it has no `.git` file left to identify it. An empty directory is harmless
 * (createPen suffixes around it) and guessing would risk reporting the user's
 * own folders. Upgrade only if empty husks ever pile up in practice.
 *
 * @returns {Promise<Array<{ path:string, kind:'stray'|'trash', gitdir:string }>>}
 */
export async function sweep(repo, { root = PEN_ROOT } = {}) {
  if (!await isRepo(repo)) throw new Error(`not a git work tree: ${repo}`);
  const commonDir = real(
    out(await gitRun(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo })));

  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch { return []; }                        // no pen root yet: nothing to sweep

  const penRoot = real(root);
  const known = await listPens(repo);
  const strays = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;           // W2: isDirectory() is false for a junction/symlink — do not follow one
    const p = path.win32.resolve(penRoot, e.name);
    if (known.some(w => same(w.path, p))) continue;

    // The identifying mark of an orphaned worktree is its `.git` *file*, which
    // still points at the repo that made it even after the bookkeeping is gone.
    // Requiring it is what keeps unrelated directories out of this list.
    const gitdir = await readGitdirFile(p);
    if (!gitdir) continue;
    if (!gitdir.toLowerCase().startsWith(commonDir.toLowerCase())) continue;
    strays.push({ path: p, kind: e.name.startsWith(TRASH_PREFIX) ? 'trash' : 'stray', gitdir });
  }
  return strays;
}

async function readGitdirFile(dir) {
  try {
    const f = path.join(dir, '.git');
    await fsp.access(f, FS.R_OK);
    const st = await fsp.stat(f);
    if (st.isDirectory()) return null;        // a real clone, not a worktree of ours
    const m = /^gitdir:\s*(.+)$/m.exec(await fsp.readFile(f, 'utf8'));
    return m ? real(m[1].trim()) : null;
  } catch { return null; }
}

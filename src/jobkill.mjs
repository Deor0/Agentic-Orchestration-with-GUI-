// Kill a process tree on Windows, including processes whose parent already
// exited. The real shape is `powershell.exe -> claude.cmd -> node.exe -> git.exe`
// and the middle links die early, so `taskkill /T` - which walks live parent
// links - loses the tail of the tree.
//
// The fix is the one Cargo uses (rust-lang/cargo#2370): a Job Object with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Membership is inherited by every child at
// CreateProcess time and survives the parent's death, so closing the last job
// handle terminates the whole descendant set in one syscall. We deliberately do
// NOT set JOB_OBJECT_LIMIT_BREAKAWAY_OK / SILENT_BREAKAWAY_OK, or children could
// escape the job.
//
// Win32 is reached through koffi, which ships a prebuilt .node per platform as
// an optional dependency. Verified on this machine: installing it never invokes
// node-gyp, cmake or a compiler - its `install` script (cnoke --prebuild) only
// `require()`s the prebuilt package and returns. It also works with npm install
// scripts blocked entirely.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const JobObjectExtendedLimitInformation = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

const win32 = process.platform === 'win32' ? loadWin32() : null;

/** 'job' when real Job Objects are in use, 'taskkill' when we fell back. */
export const mode = win32 ? 'job' : 'taskkill';

function loadWin32() {
  try {
    const koffi = createRequire(import.meta.url)('koffi');
    const k32 = koffi.load('kernel32.dll');

    const BASIC = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
      PerProcessUserTimeLimit: 'int64',
      PerJobUserTimeLimit: 'int64',
      LimitFlags: 'uint32',
      MinimumWorkingSetSize: 'size_t',
      MaximumWorkingSetSize: 'size_t',
      ActiveProcessLimit: 'uint32',
      Affinity: 'uintptr_t',
      PriorityClass: 'uint32',
      SchedulingClass: 'uint32',
    });
    const IO = koffi.struct('IO_COUNTERS', {
      ReadOperationCount: 'uint64', WriteOperationCount: 'uint64', OtherOperationCount: 'uint64',
      ReadTransferCount: 'uint64', WriteTransferCount: 'uint64', OtherTransferCount: 'uint64',
    });
    const EXT = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
      BasicLimitInformation: BASIC,
      IoInfo: IO,
      ProcessMemoryLimit: 'size_t',
      JobMemoryLimit: 'size_t',
      PeakProcessMemoryUsed: 'size_t',
      PeakJobMemoryUsed: 'size_t',
    });

    return {
      extSize: koffi.sizeof(EXT),
      CreateJobObjectW: k32.func('void * __stdcall CreateJobObjectW(void *, const char16_t *)'),
      SetInformationJobObject: k32.func('bool __stdcall SetInformationJobObject(void *, int, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *, uint32)'),
      AssignProcessToJobObject: k32.func('bool __stdcall AssignProcessToJobObject(void *, void *)'),
      OpenProcess: k32.func('void * __stdcall OpenProcess(uint32, bool, uint32)'),
      CloseHandle: k32.func('bool __stdcall CloseHandle(void *)'),
    };
  } catch {
    return null; // not Windows, or koffi missing/unloadable - fall back to taskkill
  }
}

/** A kill-on-close job with no limits other than the kill itself. */
function createJob() {
  const job = win32.CreateJobObjectW(null, null);
  if (!job) throw new Error('CreateJobObject failed');
  const info = { BasicLimitInformation: { LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE } };
  if (!win32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, info, win32.extSize)) {
    win32.CloseHandle(job);
    throw new Error('SetInformationJobObject failed');
  }
  return job;
}

function assign(job, pid) {
  const proc = win32.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid);
  if (!proc) return false;
  try {
    return win32.AssignProcessToJobObject(job, proc);
  } finally {
    win32.CloseHandle(proc); // the job holds its own reference
  }
}

const jobs = new Map(); // pid -> Supervisor

class Supervisor {
  #job;
  #killed = false;

  constructor(target) {
    this.pid = typeof target === 'number' ? target : 0;
    this.assigned = null;
    this.#job = createJob();
    this.ready = this.pid ? Promise.resolve(this.#attach()) : this.#waitForPid(target);
  }

  #attach() {
    if (!this.#job) return false;
    this.assigned = assign(this.#job, this.pid);
    if (!this.assigned) {
      // Nothing is in the job, so drop it rather than leak the handle; kill()
      // and killTree() then fall back to taskkill.
      win32.CloseHandle(this.#job);
      this.#job = null;
      return false;
    }
    jobs.set(this.pid, this);
    if (this.#killed) this.kill(); // disposed while we were still waiting for the pid
    return true;
  }

  // node-pty reports pid 0 until ConPTY's data pipe is ready (~100ms, measured),
  // so the pid has to be polled rather than read off the return of spawn().
  #waitForPid(pty) {
    return new Promise(resolve => {
      const deadline = Date.now() + 10_000;
      const timer = setInterval(() => {
        if (pty.pid) {
          this.pid = pty.pid;
          clearInterval(timer);
          resolve(this.#attach());
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          win32.CloseHandle(this.#job);
          this.#job = null;
          resolve(false);
        }
      }, 1);
      timer.unref?.();
    });
  }

  /** Close the job handle: Windows terminates every process still in it. */
  kill() {
    this.#killed = true;
    jobs.delete(this.pid);
    if (this.#job) {
      const job = this.#job;
      this.#job = null;
      return win32.CloseHandle(job);
    }
    return this.pid ? killTree(this.pid) : false; // never got into a job
  }
}

/**
 * Put a process - and everything it spawns from now on - into a kill-on-close job.
 * `target` is a pid, or a node-pty terminal (whose `.pid` is still 0 right after
 * spawn; it gets picked up as soon as ConPTY reports it).
 * Returns a supervisor with `.kill()`, `.pid` and a `.ready` promise, or null when
 * Job Objects are unavailable - in which case `killTree()` falls back to taskkill.
 */
export function superviseTree(target) {
  if (!win32) return null;
  return new Supervisor(target);
}

/**
 * Kill `pid` and all its descendants. Uses the job created by `superviseTree()`
 * when there is one, which is the only variant that reaches orphaned grandchildren.
 *
 * shortcut: without a job (koffi missing, or a pid we never supervised) this is
 * `taskkill /T`, which walks live parent links and therefore leaves behind any
 * descendant whose parent already exited. Upgrade by calling superviseTree() at
 * spawn time; there is no better fallback without holding a job handle.
 */
export function killTree(target) {
  const pid = typeof target === 'number' ? target : target?.pid;
  const sup = jobs.get(pid);
  if (sup) return sup.kill();
  if (!pid) return false;
  const r = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
  return r.status === 0;
}

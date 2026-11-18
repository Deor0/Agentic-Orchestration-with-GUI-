import { existsSync } from 'node:fs';

const ProgramFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
const SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';

// A ConPTY child starts in the OEM code page (IBM437 here, measured), which
// mangles every non-ASCII byte an agent emits. -NoExit runs this before the
// interactive session so the fix never appears in the user's scrollback.
const UTF8_INIT = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8';

// Hard rule 8: resolve shells to absolute paths. `bash.exe` alone resolves to
// three different binaries on a typical PATH (Git Bash, the System32 WSL shim,
// the WindowsApps alias) and node-pty fails with a bare "File not found".
export const SHELLS = {
  pwsh: {
    label: 'PowerShell 7',
    candidates: [`${ProgramFiles}\\PowerShell\\7\\pwsh.exe`],
    args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', UTF8_INIT],
  },
  powershell: {
    label: 'Windows PowerShell',
    candidates: [`${SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`],
    args: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', UTF8_INIT],
  },
  gitbash: {
    label: 'Git Bash',
    candidates: [
      `${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`,
      `${ProgramFiles}\\Git\\bin\\bash.exe`,
    ],
    args: ['-i', '-l'],
  },
};

/** First shell id that actually exists on disk, in preference order. */
export function defaultShellId() {
  return ['pwsh', 'powershell', 'gitbash'].find(id => resolveShell(id)) ?? null;
}

/** Absolute path for a shell id, or null if not installed. */
export function resolveShell(id) {
  return SHELLS[id]?.candidates.find(existsSync) ?? null;
}

export function available() {
  return Object.entries(SHELLS)
    .map(([id, s]) => ({ id, label: s.label, path: resolveShell(id) }))
    .filter(s => s.path);
}

/**
 * platform.cjs - Platform-specific helpers for Claude hooks and Antigravity bridge.
 * Normalizes differences between macOS, Linux, and Windows (win32).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * Returns Orca's userData directory according to platform.
 * đường dẫn win32/linux theo mặc định userData của Electron, chưa kiểm với Orca thật.
 */
function orcaDataDir(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const base = env.APPDATA ||
      (env.USERPROFILE ? path.win32.join(env.USERPROFILE, 'AppData', 'Roaming') : path.win32.join(os.homedir(), 'AppData', 'Roaming'));
    return path.win32.join(base, 'orca');
  }
  if (platform === 'linux') {
    const base = env.XDG_CONFIG_HOME ||
      (env.HOME ? path.posix.join(env.HOME, '.config') : path.posix.join(os.homedir(), '.config'));
    return path.posix.join(base, 'orca');
  }
  // darwin / default macOS
  const home = env.HOME || os.homedir();
  return path.posix.join(home, 'Library', 'Application Support', 'orca');
}

/**
 * Normalizes backslashes to forward slashes.
 */
function toSlash(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : '';
}

/**
 * Expands leading `~` only when followed by `/`, `\`, or end of string.
 */
function expandHome(p, homedir = os.homedir()) {
  if (typeof p !== 'string') return p;
  return p.replace(/^~(?=[/\\]|$)/, homedir);
}

/**
 * Compares two paths for equivalence, handling slashes, trailing slashes,
 * and case insensitivity on Windows.
 */
function samePath(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const expA = expandHome(a);
  const expB = expandHome(b);
  const p = platform === 'win32' ? path.win32 : path.posix;
  const na = toSlash(p.resolve(expA));
  const nb = toSlash(p.resolve(expB));
  if (platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

/**
 * Returns a Map of pid -> { ppid, args } for running processes.
 * On macOS/Linux uses `ps`, on Windows uses PowerShell Get-CimInstance Win32_Process.
 */
function listProcesses() {
  const procs = new Map();
  if (process.platform === 'win32') {
    try {
      const res = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      if (res.stdout) {
        let data = JSON.parse(res.stdout);
        if (!Array.isArray(data)) data = [data];
        for (const item of data) {
          if (item && item.ProcessId != null) {
            procs.set(Number(item.ProcessId), {
              ppid: Number(item.ParentProcessId || 0),
              args: item.CommandLine || '',
            });
          }
        }
      }
    } catch (_) {}
    return procs;
  }

  // macOS / Linux
  try {
    const cmd = process.platform === 'darwin' && fs.existsSync('/bin/ps') ? '/bin/ps' : 'ps';
    const res = spawnSync(cmd, ['-axww', '-o', 'pid=,ppid=,args='], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of (res.stdout || '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/);
      if (m) {
        procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
      }
    }
  } catch (_) {}
  return procs;
}

module.exports = {
  orcaDataDir,
  toSlash,
  expandHome,
  samePath,
  listProcesses,
};

'use strict';
const fs = require('fs');
const path = require('path');

// The node a hook command calls: the first `node` on PATH, a path that stays put when a package
// manager upgrades node (Homebrew's /opt/homebrew/bin/node), not process.execPath, which resolves
// to a versioned directory (Cellar/node/<version>/bin/node) the next upgrade deletes.
function getNodeBin() {
  if (process.platform === 'win32') {
    return process.execPath;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    // A relative entry would give a command that breaks once a hook runs from another cwd.
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'node');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_) {}
  }
  return process.execPath;
}

module.exports = { getNodeBin };

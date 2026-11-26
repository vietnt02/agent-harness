// True when this session has an approved plan: ~/.claude/plans/<cwd-slug>/*.md whose front matter
// says `status: approved` and names this session id (ntv-autopilot § Approve).
const fs = require('fs');
const os = require('os');
const path = require('path');

function approvedPlan(sessionId, cwd) {
  if (!sessionId) return false;
  const dirs = new Set([cwd, process.cwd()].filter(Boolean).map((p) => p.replace(/[^A-Za-z0-9]/g, '-')));
  for (const d of dirs) {
    const dir = path.join(os.homedir(), '.claude', 'plans', d);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 600);
      if (/^status: approved$/m.test(head) && head.includes(sessionId)) return true;
    }
  }
  return false;
}

module.exports = { approvedPlan };

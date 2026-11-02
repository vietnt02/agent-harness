/**
 * tests/skills-generic.test.cjs - A skill holds only what is true on any machine. A fact about one
 * machine goes to ~/.claude/knowledge/, a repo's convention to that repo, and a past incident to no
 * file at all (skills/ntv-kaizen § Apply). This scans every file under claude/skills/ for the marks
 * such content leaves: a home or app-data path, an Orca ID, a dated event, a numbered issue link, an
 * email. Names (companies, projects, repos, people) cannot be listed in a public repo: when
 * ~/.claude/knowledge/public-denylist.txt exists on the machine, every tracked file is also scanned
 * for each of its lines (one name per line, whole word, any case). CI has no such file and skips it.
 * Runs with `node --test "tests/*.test.cjs"`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const SKILLS = path.join(REPO, 'claude', 'skills');
const DENYLIST = path.join(os.homedir(), '.claude', 'knowledge', 'public-denylist.txt');

// A date `d/m` (m ≤ 12, d ≤ 31, d ≠ m so a ratio like 4/4 is not one) read as a date only by its
// context: a word before it that dates something, an opening parenthesis, or `:`/`)` right after.
const DATE_WORD = /(?:event|probe|kiểm|thử|tạo|chiều|sáng|tối|phiên|ngày|lúc|chốt|trace|w\d+,|on|checked|tested|ran|at)\s*(?:thật\s*)?$/iu;
function datedEvent(line) {
  for (const m of line.matchAll(/(\d{1,2})\/(\d{1,2})(\/20\d{2})?/g)) {
    const [d, mo] = [Number(m[1]), Number(m[2])];
    if (m[3]) return true;
    if (d < 1 || d > 31 || mo < 1 || mo > 12 || d === mo) continue;
    const before = line.slice(Math.max(0, m.index - 16), m.index);
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 12);
    // A count of things ("3/4 ca", "2/3 lần") is a ratio, not a date.
    if (/^\s+(?:ca|lần|commit|test|cổng|file|dòng|worker|bước|mục|phiên)(?![\p{L}])/u.test(after)) continue;
    // `(3/4)` alone is a fraction; `(14/10: …)` and `13/10)` (a numerator above its denominator) read as dates.
    if (DATE_WORD.test(before) || /^:/.test(after) || (/^\)/.test(after) && d > mo)) return true;
  }
  return false;
}

// Each mark: what it means, and a test. Only generic shapes, so this file can live in a public repo.
const MARKS = [
  ['a home or app-data path', (l) => /\/Users\/[^/\s<]+|~\/Workspace\/|~\/\.?orca\/|~\/Library\/|\$HOME\/Workspace|[A-Z]:\\+Users\\+|\/home\/[a-z][\w-]*\//.test(l)],
  ['an Orca ID', (l) => /\b(?:ctx|term|task|run|structworker)_[0-9a-f]{8,}\b/.test(l)],
  ['a dated event, probe or check', datedEvent],
  ['a full date', (l) => /\b20\d{2}-\d{2}-\d{2}\b/.test(l)],
  // `#000000` is a colour, not a record: 3–5 digits only.
  ['a numbered issue, PR, MR or record', (l) => /\b[\w.-]+\/[\w.-]+[#!]\d+\b|\b(?:MR|PR|issue|pull) ?[#!]\d+\b|\b[\w]+-[\w-]+[#!]\d+\b|(?:^|[\s(])[#!]\d{3,5}\b/i.test(l)],
  // An SSH remote (`git@host:org/repo`) and a `noreply@` trailer are not someone's address.
  ['an email', (l) => [...l.matchAll(/\b([\w.+-]+)@([\w-]+\.[a-z]{2,}[\w.]*)(:?)/gi)]
    .some((m) => !/^(git|noreply)$/i.test(m[1]) && !/^example\./i.test(m[2]) && !m[3])],
];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(md|cjs|js|sh|py|json)$/.test(e.name) ? [p] : [];
  });
}

test('skills hold no machine, repo or incident specifics', () => {
  const hits = [];
  for (const file of files(SKILLS)) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const [what, hit] of MARKS) {
        if (hit(line)) hits.push(`${path.relative(SKILLS, file)}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `move these to ~/.claude/knowledge/, the repo they describe, or drop them:\n${hits.join('\n')}`);
});

test('no tracked file names what the local denylist holds', { skip: !fs.existsSync(DENYLIST) && 'no local denylist' }, () => {
  const names = fs.readFileSync(DENYLIST, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // `-` and `_` split words, so `name-api` and `name_db` still hit.
  const words = names.map((n) => new RegExp(`(?<![\\p{L}\\d])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'iu'));
  const tracked = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const hits = [];
  for (const rel of tracked) {
    if (words.some((w) => w.test(rel))) hits.push(`${rel} (path)`);
    let text; try { text = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch (_) { continue; }
    text.split('\n').forEach((line, i) => {
      if (words.some((w) => w.test(line))) hits.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `a denylisted name is in a tracked file (lines only, names not printed):\n${hits.join('\n')}`);
});

test('the marks hit what they are for and miss ratios', () => {
  const hit = (s) => MARKS.some(([, h]) => h(s));
  for (const s of ['/Users/someone/x', '~/Workspace/Org/repo', '~/.orca/setup.sh', '~/orca/workspaces/r', '~/Library/Application Support/x',
    'C:\\Users\\x', 'dispatch ctx_0123456789ab', 'run_c7239fbf2290', 'Event 13/10: …', 'probe 05/10/2026', 'user chốt 15/10',
    '(kiểm 2026-09-23)', '(14/10: khởi động)', 'chiều 08/10 chưa tới', 'phiên 10/09', '(w17, 15/10)', 'tạo 02/11',
    'org/repo#72', 'group/project!311', 'some-repo#116', 'MR !218', 'đơn #1070', 'mail a.b@company.vn',
    'checked 13/10', 'on 05/10 the', 'issue #72']) {
    assert.ok(hit(s), s);
  }
  for (const s of ['14/14 cổng xanh', '87/87 test', 'CI 4/4 xanh', '5/5 commit', 'kiểm 5/5 commit', 'Kiểm 3/4 ca',
    'thử 2/3 lần', 'merge <PR>', '~/.claude/knowledge/orca.md', 'user@example.com', 'Rule #2', 'ratio (1/2)',
    'git@github.com:org/repo.git', 'Co-Authored-By: Claude <noreply@anthropic.com>', '#000000 black', 'version 1.4.246']) {
    assert.ok(!hit(s), s);
  }
});

/**
 * tests/skills-generic.test.cjs - A skill holds only what is true on any machine. A fact about one
 * machine goes to ~/.claude/knowledge/, a repo's convention to that repo, and a past incident to no
 * file at all (skills/ntv-kaizen § Apply). This scans every file under claude/skills/ for the marks
 * such content leaves: a home path, an Orca dispatch or terminal ID, a dated event or probe.
 * Runs with `node --test "tests/*.test.cjs"`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SKILLS = path.resolve(__dirname, '..', 'claude', 'skills');

// Each mark: what it means, and the pattern. Only generic shapes: the test names no company,
// project or person, so it can live in a public repo.
const MARKS = [
  ['a home path', /\/Users\/[^/\s]+|~\/Workspace\/|\/home\/[a-z][\w-]*\//],
  ['an Orca dispatch or terminal ID', /\b(?:ctx|term|task)_[0-9a-f]{8,}\b/],
  ['a dated event, probe or check', /\b(?:[Ee]vent|[Pp]robe|[Kk]iểm(?: chứng| ngày)?|[Tt]hử|user chốt(?: lại)?|chủ dự án)\s*(?:thật\s*)?\(?(?:ngày\s*)?\d{1,2}\/\d{1,2}\b/u],
  ['a full date', /\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/20\d{2}\b/],
  ['a link to a numbered issue or PR of a named repo', /\b[\w.-]+\/[\w.-]+[#!]\d+\b/],
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
      for (const [what, re] of MARKS) {
        if (re.test(line)) hits.push(`${path.relative(SKILLS, file)}:${i + 1} ${what}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `move these to ~/.claude/knowledge/, the repo they describe, or drop them:\n${hits.join('\n')}`);
});

test('the marks hit what they are for and miss ratios', () => {
  const hit = (s) => MARKS.some(([, re]) => re.test(s));
  for (const s of ['/Users/someone/x', '~/Workspace/Org/repo', 'dispatch ctx_7ababc44d66a', 'Event 13/10: …',
    'probe 05/10/2026', 'user chốt 15/10', '(kiểm 2026-09-23)', 'org/repo#72', 'group/project!311']) {
    assert.ok(hit(s), s);
  }
  for (const s of ['14/14 cổng xanh', '87/87 test', 'CI 4/4 xanh', '5/5 commit', 'merge <PR>', '~/.claude/knowledge/orca.md']) {
    assert.ok(!hit(s), s);
  }
});

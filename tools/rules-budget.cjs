#!/usr/bin/env node
/**
 * rules-budget.cjs - the characters each always-loaded rule file of this harness may hold:
 * claude/CLAUDE.md and claude/rules/agent-harness/*.md, alone and together. Characters, not lines: a
 * line cap only made sentences denser; an ambiguous rule is reworded, never added to (ntv-kaizen).
 * CI checks the tracked copy (tests/hooks.test.cjs), so an over-budget file never merges. The
 * user's own ~/.claude/rules/mine/*.md hold no budget.
 *
 *   node tools/rules-budget.cjs [<repo>/claude]   prints each file over budget, exits 1 if any
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BUDGETS = {
  'CLAUDE.md': 8200,
  'rules/agent-harness/communication-style.md': 1750,
  'rules/agent-harness/session-notes.md': 900,
};
const NEW_FILE_CHARS = 2000;
const TOTAL_CHARS = 10850;
const RULES_DIR = 'rules/agent-harness';

// "<path> n/budget" for each rule file of `claudeDir` (a checkout's `claude/`) over its budget, and
// for the total; [] when all fit. Counted as the model reads them: UTF-8 text, string length.
function overBudget(claudeDir) {
  let rules = [];
  try { rules = fs.readdirSync(path.join(claudeDir, RULES_DIR)).filter((f) => f.endsWith('.md')).sort(); } catch (_) { /* none */ }
  const files = ['CLAUDE.md', ...rules.map((f) => `${RULES_DIR}/${f}`)].map((rel) => {
    let n = 0;
    try { n = fs.readFileSync(path.join(claudeDir, ...rel.split('/')), 'utf8').length; } catch (_) { /* missing */ }
    return { rel, n, budget: BUDGETS[rel] ?? NEW_FILE_CHARS };
  });
  const out = files.filter((x) => x.n > x.budget).map((x) => `${x.rel} ${x.n}/${x.budget}`);
  const total = files.reduce((n, x) => n + x.n, 0);
  if (total > TOTAL_CHARS) out.push(`total ${total}/${TOTAL_CHARS}`);
  return out;
}

module.exports = { overBudget, BUDGETS, NEW_FILE_CHARS, TOTAL_CHARS };
if (require.main !== module) return;
const over = overBudget(process.argv[2] || path.join(__dirname, '..', 'claude'));
if (over.length) { process.stdout.write(`over budget: ${over.join(', ')}\n`); process.exit(1); }

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const child_process = require('node:child_process');

const repoDir = path.resolve(__dirname, '..');

// Hooks, the agy bridge and scripts run on agents' machines, not in other tests: a syntax error
// there (e.g. a `*/` inside a block comment) passes every behaviour test and breaks every session.
const files = child_process
  .execFileSync('git', ['ls-files', '*.cjs', '*.js', '*.mjs'], { cwd: repoDir, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

test('repo has JS files to check, the agy bridge among them', () => {
  assert.ok(files.includes('agy/claude-hook-bridge.cjs'), `got: ${files.join(', ')}`);
});

for (const file of files) {
  test(`node --check ${file}`, () => {
    const r = child_process.spawnSync(process.execPath, ['--check', path.join(repoDir, file)], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  });
}

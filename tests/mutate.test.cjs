'use strict';
// ntv-test § 3 names scripts/mutate.py as the mutation route for Python: it must run on every OS the
// harness installs on (it once stopped on Windows at POSIX-only signals before any mutant ran).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PY = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import pytest'], { encoding: 'utf8' }).status === 0);
const SCRIPT = path.join(__dirname, '..', 'claude', 'skills', 'ntv-test', 'scripts', 'mutate.py');

test('mutate.py: runs mutants on a small module and reports them', { skip: !PY && 'no python with pytest' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutate-'));
  try {
    const copy = path.join(dir, 'copy');
    fs.mkdirSync(path.join(copy, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(copy, 'm.py'), 'def f(a, b):\n    if a > b:\n        return a - b\n    return 0\n');
    fs.writeFileSync(path.join(copy, 'tests', 'test_m.py'), 'from m import f\n\ndef test_f():\n    assert f(3, 1) == 2\n    assert f(1, 3) == 0\n');
    const out = path.join(dir, 'out.json');
    const r = spawnSync(PY, ['-I', SCRIPT, copy, out, '--module', 'm.py', '--tests', 'tests/test_m.py', '--confirm-tests', 'tests/', '--python', PY], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(res.mutants.length > 0);
    assert.ok(res.mutants.every((m) => m.result === 'killed'), JSON.stringify(res.mutants));
    // A red suite on the copy (a dependency it lacks) stops before any mutant, naming the dependency.
    fs.writeFileSync(path.join(copy, 'tests', 'test_dep.py'), 'import not_installed_dep\n');
    const red = spawnSync(PY, ['-I', SCRIPT, copy, out, '--module', 'm.py', '--tests', 'tests/test_m.py', '--confirm-tests', 'tests/', '--python', PY], { encoding: 'utf8', timeout: 120000 });
    assert.notEqual(red.status, 0);
    assert.match(red.stderr, /dependencies/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

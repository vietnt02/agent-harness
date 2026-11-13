/**
 * tests/hooks.test.cjs - Test suite for Claude hooks and Antigravity bridge helpers.
 * Runs with `node --test "tests/*.test.cjs"`.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = path.join(REPO_ROOT, 'claude', 'hooks');
const SETTINGS_FILE = path.join(REPO_ROOT, 'settings', 'claude-settings.shared.json');

const platform = require('../claude/hooks/lib/platform.cjs');
const mainCheckoutGuard = require('../claude/hooks/main-checkout-guard.cjs');
const tierCGuard = require('../claude/hooks/tier-c-guard.cjs');
const userIntent = require('../claude/hooks/lib/user-intent.cjs');
const rulesBudget = require('../claude/hooks/rules-budget.cjs');
const watchGuard = require('../claude/hooks/watch-guard.cjs');
const pushAfterPrGuard = require('../claude/hooks/push-after-pr-guard.cjs');
const dispatchSplitGuard = require('../claude/hooks/dispatch-split-guard.cjs');
const worktreeAfterRelease = require('../claude/hooks/worktree-after-release.cjs');

// ---------------------------------------------------------------------------
// 1. All hooks in settings/claude-settings.shared.json
// ---------------------------------------------------------------------------
test('All hooks in settings/claude-settings.shared.json run cleanly without stack traces', async (t) => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-home-'));
  const emptyTranscript = path.join(tmpHome, 'transcript.jsonl');
  fs.writeFileSync(emptyTranscript, '');
  const tmpFile = path.join(tmpHome, 'test.txt');
  fs.writeFileSync(tmpFile, 'hello');

  try {
    const sharedSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

    for (const [eventName, groups] of Object.entries(sharedSettings.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const scriptName = hook.command.split('/').pop().replace(/"$/, '');
          const scriptPath = path.join(HOOKS_DIR, scriptName);

          await t.test(`${eventName} -> ${scriptName} (matcher: ${group.matcher || '*'})`, () => {
            assert.ok(fs.existsSync(scriptPath), `Script should exist: ${scriptPath}`);

            let payload = {
              session_id: 'test-session',
              cwd: tmpHome,
              transcript_path: emptyTranscript,
              hook_event_name: eventName,
            };

            if (eventName === 'UserPromptSubmit') {
              payload.prompt = 'hello world';
            } else if (eventName === 'SessionStart') {
              payload.source = 'startup';
            } else if (eventName === 'Stop') {
              // minimal
            } else if (eventName === 'PermissionDenied') {
              payload.tool_name = 'Bash';
              payload.tool_input = { command: 'ls' };
            } else if (eventName === 'PostToolUseFailure') {
              payload.tool_name = 'Bash';
              payload.tool_input = { command: 'ls' };
              payload.error = 'failed command';
            } else if (eventName === 'PostToolUse') {
              payload.tool_name = 'Bash';
              payload.tool_input = { command: 'ls' };
              payload.tool_response = { stdout: '', stderr: '' };
            } else if (eventName === 'PreToolUse') {
              if (group.matcher && (group.matcher.includes('Edit') || group.matcher.includes('Write'))) {
                payload.tool_name = 'Write';
                payload.tool_input = { file_path: tmpFile, content: 'test content' };
              } else if (group.matcher && (group.matcher.includes('Agent') || group.matcher.includes('Task'))) {
                payload.tool_name = 'Agent';
                payload.tool_input = { prompt: 'subagent task', run_in_background: true };
              } else {
                payload.tool_name = 'Bash';
                payload.tool_input = { command: 'ls' };
              }
            }

            const res = spawnSync(process.execPath, [scriptPath], {
              input: JSON.stringify(payload),
              encoding: 'utf8',
              timeout: 10000,
              env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
            });

            assert.ok(
              res.status === 0 || res.status === 2,
              `Hook ${scriptName} exited with unexpected status ${res.status}. Stderr: ${res.stderr}`
            );
            assert.ok(
              !res.stderr.includes('    at '),
              `Hook ${scriptName} produced stack trace in stderr: ${res.stderr}`
            );
          });
        }
      }
    }
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Unit tests for lib/platform.cjs
// ---------------------------------------------------------------------------
test('platform.cjs helpers', async (t) => {
  await t.test('orcaDataDir returns platform-specific directory', () => {
    // darwin
    assert.equal(
      platform.orcaDataDir('darwin', { HOME: '/Users/alice' }),
      '/Users/alice/Library/Application Support/orca'
    );
    // win32 with APPDATA
    assert.equal(
      platform.orcaDataDir('win32', { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }),
      'C:\\Users\\alice\\AppData\\Roaming\\orca'
    );
    // win32 fallback to USERPROFILE
    assert.equal(
      platform.orcaDataDir('win32', { USERPROFILE: 'C:\\Users\\alice' }),
      'C:\\Users\\alice\\AppData\\Roaming\\orca'
    );
    // linux with XDG_CONFIG_HOME
    assert.equal(
      platform.orcaDataDir('linux', { XDG_CONFIG_HOME: '/home/alice/.config' }),
      '/home/alice/.config/orca'
    );
    // linux fallback to HOME
    assert.equal(
      platform.orcaDataDir('linux', { HOME: '/home/alice' }),
      '/home/alice/.config/orca'
    );
  });

  await t.test('toSlash normalizes backslashes to forward slashes', () => {
    assert.equal(platform.toSlash('C:\\foo\\bar\\baz'), 'C:/foo/bar/baz');
    assert.equal(platform.toSlash('foo/bar/baz'), 'foo/bar/baz');
    assert.equal(platform.toSlash(''), '');
    assert.equal(platform.toSlash(null), '');
    assert.equal(platform.toSlash(undefined), '');
  });

  await t.test('expandHome expands ~ followed by / or \\ or at end', () => {
    assert.equal(platform.expandHome('~/docs', '/home/me'), '/home/me/docs');
    assert.equal(platform.expandHome('~\\docs', 'C:\\Users\\me'), 'C:\\Users\\me\\docs');
    assert.equal(platform.expandHome('~', '/home/me'), '/home/me');
    assert.equal(platform.expandHome('~user/docs', '/home/me'), '~user/docs');
    assert.equal(platform.expandHome('relative/path', '/home/me'), 'relative/path');
  });

  await t.test('samePath compares paths accurately across platforms', () => {
    // POSIX
    assert.ok(platform.samePath('/Users/foo/bar', '/Users/foo/bar', 'darwin'));
    assert.ok(platform.samePath('/Users/foo/bar/', '/Users/foo/bar', 'darwin'));
    assert.ok(!platform.samePath('/Users/foo/bar', '/Users/foo/baz', 'darwin'));

    // Win32 case insensitivity and slash normalization
    assert.ok(platform.samePath('C:\\Users\\Foo\\Bar', 'c:/users/foo/bar', 'win32'));
    assert.ok(platform.samePath('C:\\Users\\Foo\\Bar\\', 'C:\\users\\foo\\bar', 'win32'));
    assert.ok(!platform.samePath('C:\\Users\\Foo\\Bar', 'C:\\Users\\Foo\\Baz', 'win32'));
  });

  await t.test('listProcesses returns a Map of process entries', () => {
    const procs = platform.listProcesses();
    assert.ok(procs instanceof Map);
    // On current machine (macOS), listProcesses should find processes
    if (process.platform === 'darwin' || process.platform === 'linux') {
      assert.ok(procs.size > 0);
      const first = [...procs.values()][0];
      assert.ok(typeof first.ppid === 'number');
      assert.ok(typeof first.args === 'string');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Unit tests for modified hook path helpers on POSIX and Windows formats
// ---------------------------------------------------------------------------
test('Modified hook path helpers on POSIX and Windows formats', async (t) => {
  await t.test('main-checkout-guard: resolveDir handles ~ with / and \\', () => {
    const posixBase = '/Users/test/workspace';
    const winBase = 'C:\\Users\\test\\workspace';

    const p1 = mainCheckoutGuard.resolveDir('sub/dir', posixBase);
    assert.ok(p1.includes('sub'));

    const p2 = mainCheckoutGuard.resolveDir('~', posixBase);
    assert.equal(p2, path.resolve(os.homedir()));

    const p3 = mainCheckoutGuard.resolveDir('~/sub', posixBase);
    assert.equal(p3, path.resolve(os.homedir(), 'sub'));

    const p4 = mainCheckoutGuard.resolveDir('~\\sub', winBase);
    assert.ok(platform.samePath(p4, path.resolve(os.homedir(), 'sub')));
  });

  await t.test('rules-budget (tools): a tracked rule file or the total over budget fails CI; at the budget it passes', () => {
    const budget = require('../tools/rules-budget.cjs');
    assert.deepEqual(budget.overBudget(path.join(__dirname, '..', 'claude')), [], 'this checkout fits');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-'));
    try {
      const rules = path.join(dir, 'rules', 'agent-harness');
      fs.mkdirSync(rules, { recursive: true });
      const cap = budget.BUDGETS['CLAUDE.md'];
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'ữ'.repeat(cap));
      assert.deepEqual(budget.overBudget(dir), [], 'at the budget, counted in characters, passes');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'ữ'.repeat(cap + 1));
      fs.writeFileSync(path.join(rules, 'new.md'), 'x'.repeat(budget.NEW_FILE_CHARS + 1));
      assert.deepEqual(budget.overBudget(dir).slice(0, 2), [`CLAUDE.md ${cap + 1}/${cap}`, `rules/agent-harness/new.md ${budget.NEW_FILE_CHARS + 1}/${budget.NEW_FILE_CHARS}`],
        'a new rule file gets the new-file budget');
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x'.repeat(cap));
      fs.writeFileSync(path.join(rules, 'new.md'), 'x'.repeat(budget.NEW_FILE_CHARS));
      for (const f of ['a.md', 'b.md']) fs.writeFileSync(path.join(rules, f), 'x'.repeat(budget.NEW_FILE_CHARS));
      assert.match(budget.overBudget(dir).join(' '), new RegExp(`^total \\d+/${budget.TOTAL_CHARS}$`), 'files each within budget can still pass the total');
      fs.mkdirSync(path.join(dir, 'rules', 'mine'));
      fs.writeFileSync(path.join(dir, 'rules', 'mine', 'identities.md'), 'x'.repeat(50000));
      fs.rmSync(path.join(rules, 'a.md'));
      fs.rmSync(path.join(rules, 'b.md'));
      fs.writeFileSync(path.join(rules, 'new.md'), 'x');
      assert.deepEqual(budget.overBudget(dir), [], 'a personal rules/mine file holds no budget');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('rules-budget: isNote handles Windows and POSIX paths; a rule file is no longer its business', () => {
    const home = os.homedir();
    const noteFile = path.join(home, '.claude', 'session-notes', 'slug', 'note.md');
    assert.ok(rulesBudget.isNote(noteFile));
    assert.ok(!rulesBudget.isNote(path.join(home, '.claude', 'rules', 'mine', 'note.md')));
    const md = path.join(home, '.claude', 'CLAUDE.md');
    assert.equal(rulesBudget.problem(md, 'x', 'x'.repeat(20000)), null, 'CI holds the rule budgets, not this hook');
  });

  await t.test('dispatch-split-guard: rootOf() handles POSIX and Windows separators', () => {
    assert.equal(dispatchSplitGuard.rootOf('src/index.js'), 'src/');
    assert.equal(dispatchSplitGuard.rootOf('src\\index.js'), 'src/');
    assert.equal(dispatchSplitGuard.rootOf('nested/deep/file.py'), 'nested/');
    assert.equal(dispatchSplitGuard.rootOf('nested\\deep\\file.py'), 'nested/');
    assert.equal(dispatchSplitGuard.rootOf('package.json'), '.');
    assert.equal(dispatchSplitGuard.rootOf('./src/main.rs'), 'src/');
    assert.equal(dispatchSplitGuard.rootOf('.\\src\\main.rs'), 'src/');
  });

  await t.test('dispatch-split-guard: unrelatedTasks() treats Windows backslash paths correctly', () => {
    const ctx = { serial: () => false, pressure: () => 1 };
    // Task with unrelated source files
    const lineUnrelated = 'Track: w1 <- taskA [src\\a.py] | taskB [lib\\b.py]';
    const split = dispatchSplitGuard.unrelatedTasks(lineUnrelated, ctx);
    assert.deepEqual(split, ['taskB']);

    // Task sharing a source file with backslashes
    const lineRelated = 'Track: w1 <- taskA [src\\shared.py, src\\a.py] | taskB [src\\shared.py, lib\\b.py]';
    const splitRelated = dispatchSplitGuard.unrelatedTasks(lineRelated, ctx);
    assert.deepEqual(splitRelated, []);
  });

  await t.test('push-after-pr-guard: expand() handles ~ with / and \\', () => {
    const base = '/some/dir';
    const e1 = pushAfterPrGuard.expand('~/code', base);
    assert.equal(e1, path.resolve(os.homedir(), 'code'));

    const e2 = pushAfterPrGuard.expand('~\\code', base);
    assert.ok(platform.samePath(e2, path.resolve(os.homedir(), 'code')));
  });

  await t.test('push-after-pr-guard: reads remote and branches past flag values', () => {
    const base = path.resolve('/r');
    const one = (c) => pushAfterPrGuard.findPushes(c, base);
    assert.deepEqual(one('git push -o ci.skip origin feat'), [{ dir: base, remote: 'origin', refspecs: ['feat'] }]);
    assert.deepEqual(one('git push --push-option ci.skip up a:b'), [{ dir: base, remote: 'up', refspecs: ['a:b'] }]);
    assert.deepEqual(one('git -c core.sshCommand="ssh -i k" push origin feat')[0].refspecs, ['feat']);
    assert.equal(one('cd sub && git -C "a b" push')[0].dir, path.resolve(base, 'sub', 'a b'));
    assert.deepEqual(one('git push origin --delete old'), []);
    assert.deepEqual(one('git push origin :old'), [], 'an empty source deletes');
    assert.deepEqual(one('git push 2>&1 | tail -3'), [{ dir: base, remote: null, refspecs: [] }], 'a bare push: the branch\'s own remote');
    assert.deepEqual(one('git push origin feat > log 2>&1')[0].refspecs, ['feat']);
    assert.equal(one('git push --repo up')[0].remote, 'up');
    assert.equal(one('git push --repo=up')[0].remote, 'up');
    assert.equal(pushAfterPrGuard.redact('https://x-access-token:SECRET@github.com/a/b.git'), 'https://***@github.com/a/b.git');
    assert.deepEqual(one('git status'), []);
    assert.equal(one('WT=/w/t\ncd $WT && git push -u origin feat')[0].dir, path.resolve('/w/t'), 'a variable the command set');
    assert.equal(one('export WT=/w; D=${WT}/t; git -C "$D" push')[0].dir, path.resolve('/w/t'));
    assert.equal(one('cd $UNSET && git push')[0].dir, null, 'an unknown variable hides the directory');
    assert.equal(one('WT=$(pwd); cd $WT && git push')[0].dir, null);
    assert.equal(one('WT=/a; unset WT; git -C $WT push')[0].dir, null, 'another command may rebind the name');
    for (const text of ["git commit -F - <<'EOF'\nthen git push origin merged\nEOF", 'echo "git push origin merged"',
      "node -e 'run(`git push origin merged`)'", '# git push origin merged'])
      assert.deepEqual(one(text), [], `text is not a push: ${text}`);
    assert.equal(one('(cd sub && git push); git push')[1].dir, base, 'a cd inside (…) ends with it');
    assert.equal(one('/usr/bin/git push origin feat')[0].remote, 'origin');
    for (const real of ['eval git push origin feat', 'bash -c \'cd /x; git push origin feat\'', 'sh -c "git fetch && git push origin feat"',
      'doas git push origin feat', 'stdbuf -oL git push origin feat', 'time -p git push origin feat', 'env -C /x git push origin feat'])
      assert.deepEqual(one(real).map((p) => p.refspecs), [['feat']], `a real push: ${real}`);
    assert.equal(one("bash -c 'cd /x; git push origin feat'")[0].dir, path.resolve('/x'));
    assert.equal(one('env -C /x git push origin feat')[0].dir, path.resolve('/x'));
    assert.equal(one('bash -c "cd $UNSET && git push"')[0].dir, null);
    assert.equal(one('cd $UNSET && bash -c "git push"')[0].dir, null);
  });

  await t.test('push-after-pr-guard: a push whose directory cannot be known or is not made yet says nothing', () => {
    const reviews = () => { throw new Error('must not be asked'); };
    const r = pushAfterPrGuard.decide('cd $UNSET && git push origin feat', '/r', { reviews, branches: (p) => p.refspecs });
    assert.deepEqual(r, { blind: [] });
    const gone = pushAfterPrGuard.decide('cd /no/such/dir/xyz && git push origin feat', '/r');
    assert.deepEqual(gone, { blind: [] }, 'a worktree the same command makes');
  });

  await t.test('push-after-pr-guard: blocks a merged or closed branch, voices what it could not read', () => {
    const states = { merged: [{ id: '#1', state: 'MERGED' }], closed: [{ id: '!2', state: 'CLOSED' }],
      reopened: [{ id: '#3', state: 'MERGED' }, { id: '#4', state: 'OPEN' }], fresh: [] };
    const reviews = (dir, remote, branch) => {
      if (branch === 'broken') throw Object.assign(new Error('Command failed: gh pr list'), { stderr: 'warn\nHTTP 401: Bad credentials\n' });
      return states[branch];
    };
    const decide = (c) => pushAfterPrGuard.decide(c, '/r', { reviews, branches: (p) => p.refspecs });
    assert.match(decide('git push origin merged').block, /"merged" already had #1 MERGED/);
    assert.match(decide('git push origin closed').block, /!2 CLOSED/);
    assert.deepEqual(decide('git push origin reopened'), { blind: [] }, 'an open PR on the branch lets it through');
    assert.deepEqual(decide('git push origin fresh'), { blind: [] }, 'no PR yet');
    assert.deepEqual(decide('git push origin broken'), { blind: ['"broken" (origin): HTTP 401: Bad credentials'] });
    const failing = pushAfterPrGuard.decide('git push', '/r', { reviews, branches: () => { throw new Error('not a git repo'); } });
    assert.match(failing.blind[0], /not a git repo/);
  });

  await t.test('push-after-pr-guard: tries the other identities only after the shell one fails', () => {
    let asked = 0;
    const more = () => { asked += 1; return [{ GH_TOKEN: 'a' }, { GH_TOKEN: 'b' }]; };
    assert.equal(pushAfterPrGuard.firstThatWorks(more, () => 'ok'), 'ok');
    assert.equal(asked, 0);
    assert.equal(pushAfterPrGuard.firstThatWorks(more, (env) => { if (env.GH_TOKEN !== 'b') throw new Error('no'); return 'b'; }), 'b');
    assert.throws(() => pushAfterPrGuard.firstThatWorks(() => [], () => { throw new Error('first'); }), /first/);
    let tried = 0;
    const hang = () => { tried += 1; throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); };
    assert.throws(() => pushAfterPrGuard.firstThatWorks(more, hang), /timed out/);
    assert.equal(tried, 1, 'a timeout does not try other identities');
  });

  await t.test('push-after-pr-guard: voices a pass it could not check', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'papg-'));
    execFileSync('git', ['init', '-q', '-b', 'feat', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/nobody-here/none.git']);
    const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, 'push-after-pr-guard.cjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin feat' }, cwd: repo }),
      encoding: 'utf8', timeout: 60000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /không đọc được PR\/MR của "feat"/);
  });
});

// ---------------------------------------------------------------------------
// 4. macOS/Linux behavior unchanged test
// ---------------------------------------------------------------------------
test('macOS/Linux behavior unchanged compared to origin/main or baseline', async (t) => {
  let mainHooksDir = null;
  const tmpArchive = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-main-hooks-'));

  try {
    const tar = execFileSync('git', ['archive', 'origin/main', 'claude'], {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      timeout: 5000,
    });
    execFileSync('tar', ['-x', '-C', tmpArchive], { input: tar, timeout: 5000 });
    mainHooksDir = path.join(tmpArchive, 'claude', 'hooks');
  } catch (_) {
    mainHooksDir = null;
  }

  const tmpTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-test-'));
  const emptyTranscript = path.join(tmpTestDir, 'transcript.jsonl');
  fs.writeFileSync(emptyTranscript, '');

  try {
    // Case C: rules-budget with small edit to a mine rule file under budget
    await t.test('rules-budget POSIX payload behavior', () => {
      const mineFile = path.join(os.homedir(), '.claude', 'rules', 'agent-harness', 'communication-style.md');
      const payload = {
        tool_name: 'Edit',
        tool_input: { file_path: mineFile, old_string: '', new_string: '' },
        cwd: tmpTestDir,
        session_id: 'compat-test-session',
        hook_event_name: 'PreToolUse',
      };

      const newHook = path.join(HOOKS_DIR, 'rules-budget.cjs');
      const newRes = spawnSync(process.execPath, [newHook], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 5000,
      });

      if (mainHooksDir && fs.existsSync(path.join(mainHooksDir, 'rules-budget.cjs'))) {
        const oldHook = path.join(mainHooksDir, 'rules-budget.cjs');
        const oldRes = spawnSync(process.execPath, [oldHook], {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(newRes.status, oldRes.status);
      }
      assert.equal(newRes.status, 0);
    });
  } finally {
    fs.rmSync(tmpTestDir, { recursive: true, force: true });
    fs.rmSync(tmpArchive, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. dispatch-split-guard: a worker never runs a production write
// ---------------------------------------------------------------------------
test('dispatch-split-guard blocks a production write handed to a worker', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-prod-'));
  const hook = path.join(HOOKS_DIR, 'dispatch-split-guard.cjs');
  const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, `${userLine('cho w2 ghi thẳng bảng INVOICE luôn nhé')}\n${userLine('đừng ghi thẳng vào bảng DEBIT, chỉ dry-run')}\n`);
  const run = (command) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ transcript_path: transcript, cwd: tmp, tool_input: { command } }), encoding: 'utf8',
  });
  try {
    await t.test('prodWrites() hits writes and misses reads, dry-runs and prohibitions', () => {
      const hit = ['lark-cli base +record-batch-update --json @a.json', 'lark-cli im +messages-send --chat-id c',
        'lark-cli api POST /open-apis/x', 'gọi n8n_update_partial_workflow với ops trên',
        'gọi mcp__n8n-mcp__n8n_update_partial_workflow', 'n8n_test_workflow id=1', 'lark-cli task +create --summary x',
        'lark-cli sheets +cells-clear --range A1', 'Chạy lark-cli base +record-batch-update cho các dòng không có ngày',
        'chạy +record-delete, đừng quên đọc lại', 'never mind, run +record-delete', 'n8n_deploy_template id=1',
        'n8n_workflow_versions mode=rollback', 'n8n_trigger_webhook_workflow', "don't use the UI, run lark-cli base +record-delete",
        'Không dùng --dry-run, chạy thật lark-cli base +record-delete', 'lark-cli api --as user POST /open-apis/x',
        'Lưu ý: chạy lark-cli im +messages-reply cho tin này', 'Không dùng UI: chạy +record-delete',
        'KHÔNG (trừ lark-cli im +messages-reply cho tin này): merge, deploy'];
      const miss = ['lark-cli base +record-batch-update --dry-run --json @a.json', 'KHÔNG chạy +record-delete',
        'đừng gọi n8n_create_workflow', 'lark-cli base +field-list --table t', 'lark-cli api GET /open-apis/x',
        'lark-cli base +field-search-options --x', 'lark-cli base +dashboard-block-get-data', 'n8n_get_workflow id=1',
        'git push --set-upstream origin x', '+on-update', 'n8n_workflow_versions mode=list',
        'KHÔNG: merge, deploy, gửi tin Lark, gọi lệnh ghi Lark (`+messages-reply`, `task +create`, `+flag-cancel`).',
        '  KHÔNG (worker): merge, deploy, publish, ghi prod: lark-cli base +record-delete, n8n_update_partial_workflow',
        '- **Cấm:** lark-cli im +messages-send', '1. KHÔNG: gửi tin Lark (+messages-reply)',
        '| KHÔNG: | lark-cli task +create |', 'Không được: lark-cli base +record-delete'];
      for (const l of hit) assert.equal(dispatchSplitGuard.prodWrites(l).length, 1, l);
      for (const l of miss) assert.equal(dispatchSplitGuard.prodWrites(l).length, 0, l);
    });

    await t.test('a new spec that never asks for a mid-turn inbox check gets a nudge, never a block', () => {
      const ws = 'worker' + '-start';
      const spec = (name, body) => { fs.writeFileSync(path.join(tmp, name), body); return name; };
      const flags = '--agent antigravity --model gemini-3.8-flash --effort high';
      const cmd = (rest) => `# Track: w9 ← rà [a.py]\ncd "${tmp}" && orca orchestration ${ws} ${rest} ${flags}`;
      const yes = spec('yes.md', 'Rà a.py. Chạy `orca orchestration check --peek` trước mỗi commit.');
      const no = spec('no.md', 'Rà a.py, báo lại.');
      const neg = spec('neg.md', 'Rà a.py. Đừng chạy `orca orchestration check --peek`.');
      const block = (c, why) => {
        const r = run(c);
        assert.equal(r.status, 0, `${why}: ${r.stderr}`);
        assert.match(r.stdout, /additionalContext.*inbox mid-turn/, why);
      };
      const pass = (c, why) => {
        const r = run(c);
        assert.equal(r.status, 0, `${why}: ${r.stderr}`);
        assert.doesNotMatch(r.stdout, /inbox mid-turn/, why);
      };
      block(cmd(`--spec-file ${no}`), 'spec without it');
      block(cmd(`--spec-file ${neg}`), 'a negated mention');
      block(`# nhắc: check --peek\n${cmd(`--spec-file ${no}`)}`, 'a comment in the command is not the spec');
      block(`orca orchestration check --peek; ${cmd(`--spec-file ${no}`)}`, 'the coordinator checking is not the spec');
      block(`${cmd(`--spec-file ${yes}`)}; orca orchestration ${ws} --spec-file ${no} ${flags}`, 'each dispatch is judged');
      block(`orca orchestration task-create --spec 'Rà a.py'`, 'task-create brings a spec too');
      block(`# Track: w9 ← rà [a.py]\ncd "${tmp}" && D=$(orca orchestration ${ws} --spec-file ${no} ${flags} --json)`, 'a dispatch inside $(…)');
      block(`T=\`orca orchestration task-create --spec 'Rà a.py'\``, 'a task-create inside backticks');
      block(`git commit -m "don't"; T=\`orca orchestration task-create --spec 'Rà a.py'\``, 'a lone quote inside "…" hides nothing');
      block(`cat > /tmp/n <<'EOF'\nDon't push.\nEOF\nT=\`orca orchestration task-create --spec 'Rà a.py'\``, 'a quote in a heredoc body hides nothing');
      block(cmd(`--spec-file ${no} --task-title x`), '--task-title is not --task');
      pass(cmd(`--spec "Không push; chạy orca orchestration check --peek sau mỗi 10 lệnh"`), 'a `;` inside the inline spec');
      pass(cmd(`--spec "$(cat <<'EOF'\nRà a.py.\nChạy orca orchestration check --peek trước mỗi commit.\nEOF\n)"`), 'a heredoc spec');
      block(cmd(`--spec "$(cat <<'EOF'\nRà a.py.\nEOF\n)"`), 'a heredoc spec without it');
      pass(cmd('--spec "$SPEC"'), 'an inline spec in a variable is not judged');
      const two = (a, b) => `${cmd(`--spec "$(cat <<'EOF'\n${a}\nEOF\n)"`)}\norca orchestration ${ws} --spec "$(cat <<'EOF'\n${b}\nEOF\n)" ${flags}`;
      block(two('Chạy orca orchestration check --peek.', 'Rà b.py.'), 'each heredoc spec is read from its own body');
      pass(`cat > /tmp/x <<'EOF'\nnotes\nEOF\n${cmd(`--spec "$(cat <<'EOF'\nChạy orca orchestration check --peek.\nEOF\n)"`)}`, 'an earlier heredoc is not the spec');
      pass(cmd(`--spec-file ${yes}`), 'spec with it');
      pass(cmd(`--spec "Rà a.py; chạy orca orchestration check --unread --peek sau mỗi 10 lệnh"`), 'inline, other flags between');
      pass(cmd('--task task_1 --retry-of ctx_1'), 'a --task retry runs a Task already judged');
      pass(cmd('--spec-file "$F"'), 'a spec path in a variable is not judged');
      pass(cmd('--spec-file missing.md'), 'an unreadable spec is not judged');
      pass(`orca orchestration ${ws} --help`, 'help');
    });

    await t.test('the words of a dispatch inside a quoted string are not a dispatch', () => {
      const ws = 'worker' + '-start';
      for (const c of [`git commit -m "docs: mô tả \\\`orca orchestration ${ws}\\\` trong skill"`,
        `orca orchestration send --to w1 --message "ví dụ: D=\\$(orca orchestration ${ws} --spec-file a.md)"`,
        `gh pr create --body 'Docs: \`orca orchestration send\` rồi lark-cli base +record-update'`,
        `CMD='cd /x && orca orchestration ${ws} --spec-file a.md'; echo "$CMD"`,
        `python3 -c "print('cd /x && orca orchestration ${ws} --spec-file a.md')"`,
        `cat > /tmp/s.md <<'EOF'\norca orchestration ${ws} --spec-file a.md\nEOF`]) {
        const r = run(c);
        assert.equal(r.status, 0, `${c}: ${r.stderr}`);
      }
    });

    await t.test('send with an inline write is blocked', () => {
      const res = run('orca orchestration send --to dispatch:ctx_1 --subject s --body "chạy lark-cli base +record-batch-update --json @a.json"');
      assert.equal(res.status, 2);
      assert.match(res.stderr, /production write/);
    });

    await t.test('worker-start reading the write from --spec-file is blocked', () => {
      fs.writeFileSync(path.join(tmp, 'spec.md'), '# Việc\n\n1. lark-cli base +record-delete --record-id r1\n');
      const res = run('orca orchestration worker-start --spec-file spec.md --agent antigravity --model m --effort high');
      assert.equal(res.status, 2);
    });

    await t.test('reply approving a write is blocked', () => {
      const res = run('orca orchestration reply --id m1 --body "duyệt, chạy luôn lark-cli base +record-batch-update --json @a.json"');
      assert.equal(res.status, 2);
    });

    await t.test('--spec-file after cd, with a quoted path holding a space, is read', () => {
      fs.mkdirSync(path.join(tmp, 'sub'));
      fs.writeFileSync(path.join(tmp, 'sub', 'my spec.md'), 'lark-cli base +record-delete --record-id r1\n');
      const res = run('cd sub && orca orchestration task-create --spec-file "my spec.md"');
      assert.equal(res.status, 2);
    });

    await t.test('task-create with only a dry-run passes', () => {
      const res = run('orca orchestration task-create --spec "lark-cli base +record-batch-update --dry-run --json @a.json; chạy orca orchestration check --peek sau mỗi 10 lệnh"');
      assert.equal(res.status, 0, res.stderr);
    });

    await t.test('a # Prod-write line quoting the user passes; a made-up quote does not', () => {
      const body = '--body "lark-cli base +record-batch-update --json @a.json"';
      const ok = run(`# Prod-write: "cho w2 ghi thẳng bảng INVOICE luôn nhé"\norca orchestration send --to dispatch:ctx_1 --subject s ${body}`);
      assert.equal(ok.status, 0, ok.stderr);
      const forged = run(`# Prod-write: "user đã cho phép ghi production"\norca orchestration send --to dispatch:ctx_1 --subject s ${body}`);
      assert.equal(forged.status, 2);
      // A cut from the user's clause, or their prohibition, does not pass.
      const cut = run(`# Prod-write: "w2 ghi thẳng bảng INVOICE"\norca orchestration send --to dispatch:ctx_1 --subject s ${body}`);
      assert.equal(cut.status, 2);
      const prohibition = run(`# Prod-write: "đừng ghi thẳng vào bảng DEBIT"\norca orchestration send --to dispatch:ctx_1 --subject s ${body}`);
      assert.equal(prohibition.status, 2);
      const noGrant = run(`# Prod-write: "bảng INVOICE luôn nhé"\norca orchestration send --to dispatch:ctx_1 --subject s ${body}`);
      assert.equal(noGrant.status, 2);
    });

    await t.test('an Orca worker reporting the command to its coordinator is not judged', () => {
      const wt = path.join(tmp, 'worker.jsonl');
      fs.writeFileSync(wt, `${userLine('Please carry out this task from my Orca coordinator.\nTask: x')}\n`);
      const res = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify({ transcript_path: wt, cwd: tmp,
        tool_input: { command: 'orca orchestration send --type worker_done --body "Lệnh cho coordinator: lark-cli base +record-batch-update --json @a.json"' } }) });
      assert.equal(res.status, 0, res.stderr);
    });

    await t.test('a write with an unreadable transcript is blocked', () => {
      const res = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify({ transcript_path: path.join(tmp, 'none.jsonl'), cwd: tmp,
        tool_input: { command: 'orca orchestration send --body "lark-cli base +record-delete --record-id r1"' } }) });
      assert.equal(res.status, 2);
    });

    await t.test('a command that is not for a worker is not judged', () => {
      const res = run('lark-cli base +record-batch-update --json @a.json');
      assert.equal(res.status, 0);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('shell-words: innerScript reads -c only among the shell\'s own options', () => {
  const { innerScript } = require('../claude/hooks/lib/shell-words.cjs');
  for (const [w, out] of [[['bash', '-c', 'x'], 'x'], [['sh', '-lc', 'x'], 'x'], [['bash', '-euo', 'pipefail', '-c', 'x'], 'x'],
    [['bash', '--norc', '-c', 'x'], 'x'], [['bash', '-o', 'pipefail', '-c', 'x'], 'x'], [['sh', 'script.sh', '-c', 'git push'], null],
    [['bash', './run.sh', '-c'], null], [['bash', 'x.sh'], null], [['eval', 'a', 'b'], 'a b'],
    [['bash', '--rcfile', 'f', '-c', 'x'], 'x'], [['bash', '--init-file', 'f', '-c', 'x'], 'x'], [['zsh', '--emulate', 'sh', '-c', 'x'], 'x'],
    [['bash', '--rcfile=f', '-c', 'x'], 'x'], [['bash', '-c', '--', 'x'], 'x'], [['bash', '-co', 'pipefail', 'x'], 'x'],
    [['bash', '-oc', 'pipefail', 'x'], 'x'], [['bash', '--', '-c', 'x'], null], [['bash', '-O', 'extglob', '-c', 'x'], 'x'],
    [['bash', '-c', 'x', 'sh', 'a'], 'x'], [['bash', '-c', '-e', 'x'], 'x'], [['sh', '-c', '-o', 'pipefail', 'x'], 'x'],
    [['bash', '-c', '-e', '--', 'x'], 'x'], [['bash', '-o', 'pipefail', '-oc', 'x'], null]])
    assert.equal(innerScript(w), out, JSON.stringify(w));
});

test('shell-words: a backslash in double quotes escapes only $ ` " \\', () => {
  const { commands } = require('../claude/hooks/lib/shell-words.cjs');
  assert.deepEqual([...commands('echo "a\\b \\$x \\" \\\\"')[0]], ['echo', 'a\\b $x " \\']);
});

test('main-checkout-guard: only git that runs is a git write', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-echo-'));
  execFileSync('git', ['init', '-q', tmp]);
  const linked = path.join(tmp, 'linked');
  fs.writeFileSync(path.join(tmp, 'f'), 'x');
  execFileSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x', '--allow-empty']);
  execFileSync('git', ['-C', tmp, 'worktree', 'add', '-q', linked]);
  const writes = (command) => mainCheckoutGuard.writesMainCheckout(command, tmp);
  // Bash command strings use forward slashes: a shell reads `\` as an escape (Git Bash on Windows too).
  const L = linked.split(path.sep).join('/');
  const T = tmp.split(path.sep).join('/');
  try {
    await t.test('git quoted as text, in a comment or a heredoc passes', () => {
      for (const c of [
        'echo "Worktree: \\`git fetch origin x && git checkout --detach abc\\`."',
        "{ echo '# Spec'; echo \"run: git fetch && git checkout x\"; } > /tmp/w1.md",
        'printf "%s\\n" "git -C repo reset --hard && git merge x" > /tmp/s.md',
        'echo hi \\&\\& git checkout x',
        "echo 'Run `git fetch` && git checkout x' > /tmp/spec.md",
        "echo 'see $(git rev-parse HEAD) && git merge x' > /tmp/spec.md",
        'if true; then :; else echo "a && git checkout x"; fi',
        'command echo "a && git checkout x"',
        '# git checkout main',
        "cat > /tmp/s.md <<'EOF'\ngit checkout main\nEOF",
        `cd "${L}" && git checkout -q HEAD`,
        `git -C "${L}" reset --hard`,
        'git fetch origin && git show origin/main:f',
        `WT="${L}"\ncd $WT && git commit -q --allow-empty -m x`,
        `export WT="${L}"; git -C "\${WT}" reset --hard`,
        `WT="${L}"; git -C "$WT" commit -m "$(date)"`,
      ]) assert.equal(writes(c), false, c);
    });
    await t.test('git that runs stays gated, whatever text surrounds it', () => {
      for (const c of [
        'echo start; git checkout main',
        'echo "a" && git merge feat',
        'echo "$(git checkout main)"',
        'echo "x" "$(git reset --hard)"',
        'echo "`true && git checkout main`"',
        'echo `git checkout main`',
        'echo "${x:-`git checkout main`}"',
        'git commit -m "echo x"',
        `grep "a;echo it's" f && git checkout main`,
        "echo $'it\\'s'; git checkout main",
        "# note; echo can't hurt\ngit checkout main",
        `ls "x|echo don't" ; git reset --hard`,
        'echo "a\\"b" && git checkout main',
        `cd "${L}" && cd .. && git stash`,
        `git -C "${L}" -C .. branch -D x`,
        'sudo git clean -fd',
        'echo "$(printf "%s" x; git checkout main)"',
        `echo "$(printf '"')" && git checkout main`,
        'out="$(git log -1 --format="%H" && git reset --hard)"',
        'bash -c "true; git checkout main"',
        'eval "true; git checkout main"',
        'sh -c "git checkout main"',
        ...['-u', '-m wip', '--keep-index', 'save wip', 'branch tmp', 'store abc'].map((a) => `git stash ${a}`),
        'git branch -f main HEAD~1',
        'git branch -Df x',
        'git update-ref refs/heads/main HEAD~1',
        'git tag -f v1',
        `git --work-tree . checkout main`,
        `cd "${L}" && git --work-tree="${T}" checkout main`,
        `cd "${L}" && GIT_WORK_TREE="${T}" git checkout main`,
        'xargs -J % git branch -D %',
        `cd "${L}" && env -C "${T}" git checkout main`,
        `(cd "${L}" && git status); git checkout main`,
        `x=$(cd "${L}"; pwd); git checkout main`,
        `cd "${L}" && pushd "${T}" && git checkout main`,
        `cd "${L}" && cd -- "${T}" && git checkout main`,
        `cd "${L}" && cd -P "${T}" && git checkout main`,
        `cd "${L}" && M="${T}"; cd $M && git checkout main`,
        `cd "${L}" && cd $UNSET && git checkout main`,
        `WT=$(pwd); cd "${L}" && cd $WT && git checkout main`,
        ...['if true; then WT=.; fi', '{ WT=.; }', 'unset WT', 'for WT in .; do :; done', 'read WT </dev/null', 'export WT=. OTHER']
          .map((rebind) => `WT="${L}"; ${rebind}; git -C "$WT" commit -m x`),
        `cd "${L}" && cd - && git checkout main`,
        `cd "${L}" && cd "${L}/not-made-yet" && git checkout main`,
        'cat <<EOF > /tmp/x && git checkout main\nbody\nEOF',
        'cat > /tmp/f <<EOF\n$(git checkout main)\nEOF',
      ]) assert.equal(writes(c), true, c);
    });
    await t.test('printed text after a substitution, or under a dashed heredoc tag, is not run', () => {
      for (const c of [
        'gh pr create --body "see $(date); git checkout main"',
        'echo "$(date) \\$(git checkout main)"',
        "cat <<'END-X'\ngit checkout main\nEND-X",
        "cat > /tmp/f <<'EOF'\n$(git checkout main)\nEOF",
        `(cd "${L}" && git checkout -q HEAD)`,
        `cd "${L}" && x=$(cd "${T}"; pwd) && git checkout -q HEAD`,
        `cd "${L}" && bash -c "git checkout -q HEAD"`,
        'ssh host "git checkout main"',
        `cd -- "${L}" && git checkout -q HEAD`,
        'git stash list',
        'git branch -a',
        'git tag -l',
      ]) assert.equal(writes(c), false, c);
    });
    await t.test('upkeep that starts no work in the checkout passes: pull, worktree add/move/remove, a safe branch delete', () => {
      for (const c of [
        'git pull --ff-only',
        'bash -lc \'git pull\'',
        'timeout 30 git pull',
        'git pull -q --ff-only origin',
        'git pull --rebase',
        'git pull --depth 1 origin',
        'git pull -X theirs origin',
        'git pull -s ours origin',
        'git pull -Xdiff-algorithm=patience',
        'git worktree add -q ../wt -b fix/x origin/main',
        'git worktree add -bfix/x ../wt origin/main',
        'git worktree remove ../wt',
        'git worktree move ../wt ../wt2',
        'git worktree prune',
        'git branch -d fix/x feat/y',
        'git branch --delete fix/x',
        'xargs -s 100 git branch -d',
      ]) assert.equal(writes(c), false, c);
      for (const c of [
        'git worktree remove --force ../wt',
        'git worktree remove --forc ../wt',
        'git worktree remove -ff ../wt',
        'git worktree move -f ../wt ../wt2',
        'git worktree add -Bx ../wt origin/main',
        'git worktree add -qBx ../wt origin/main',
        'git worktree add -fq ../wt x',
        'git worktree add -fB x ../wt',
        'git branch -df x',
        'git branch -fd x',
        'git branch --force -d x',
        'git pull origin feat/x',
        'git pull origin main',
        'git pull --squash origin',
        'git pull --no-commit',
        'git pull --no-ff',
        'git pull --force origin main:main',
        'git pull origin +main:main',
        'git pull -f',
        'git worktree remove -f ../wt',
        'git worktree add -B main ../wt origin/main',
        'git worktree add --force ../wt main',
        'git branch -d -f x',
        'git branch --delete --force x',
      ]) assert.equal(writes(c), true, c);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('worktree-after-release: reads the worktree from either worker-show shape, and says when it cannot', () => {
  const show = (result) => () => JSON.stringify({ ok: true, result });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'war-')));
  try {
    execFileSync('git', ['init', '-q', path.join(tmp, 'main')]);
    execFileSync('git', ['-C', path.join(tmp, 'main'), '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x', '--allow-empty']);
    const wt = path.join(tmp, 'wt');
    execFileSync('git', ['-C', path.join(tmp, 'main'), 'worktree', 'add', '-q', wt]);
    assert.equal(worktreeAfterRelease.linkedWorktree('ctx_1', show({ workspace: `id::${wt}` })), wt);
    assert.equal(worktreeAfterRelease.linkedWorktree('ctx_1', show({ worker: { worktreeId: `id::${wt}` } })), wt);
    assert.equal(worktreeAfterRelease.linkedWorktree('ctx_1', show({ workspace: `id::${path.join(tmp, 'main')}` })), null);
    assert.throws(() => worktreeAfterRelease.linkedWorktree('ctx_1', show({ state: 'succeeded' })), /workspace/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worktree-after-release: a refused release keeps its worktree; dirty file names stay whole', () => {
  // Both texts as Orca printed them (plain and --json).
  const plain = 'error: dispatch_inactive: Dispatch ctx_0b4e4e10585e is ready; only a settled worker can release. Use worker-stop to cancel an active worker.';
  const json = '{"ok":false,"error":{"code":"dispatch_inactive","message":"Dispatch ctx_6ed1b7b55ec6 is start_unknown; only a settled worker can release."}}';
  assert.match(worktreeAfterRelease.refused('ctx_0b4e4e10585e', plain), /worker-stop --dispatch ctx_0b4e4e10585e/);
  assert.match(worktreeAfterRelease.refused('ctx_6ed1b7b55ec6', json), /start_unknown/);
  assert.match(worktreeAfterRelease.refused('ctx_1', '{"ok":false,"error":"Unknown flag --run"}'), /báo lỗi/);
  assert.equal(worktreeAfterRelease.refused('ctx_1', '{"ok":true,"result":{"state":"released"}}'), null);
  const two = '{"ok":true}\n{"ok":false,"error":{"message":"Dispatch ctx_b is running; only a settled worker can release."}}';
  assert.equal(worktreeAfterRelease.refused('ctx_a', two, false), null, 'one refusal does not hide the other release');
  assert.match(worktreeAfterRelease.refused('ctx_b', two, false), /running/);
  assert.match(worktreeAfterRelease.refused('ctx_a', 'error: unknown flag --x', false), /báo lỗi/, 'nothing released, several ids');
  const hook = path.join(HOOKS_DIR, 'worktree-after-release.cjs');
  const out = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify({
    tool_name: 'Bash', tool_input: { command: 'orca orchestration worker-release --dispatch ctx_0b4e4e10585e' },
    tool_response: { stdout: plain, stderr: '' } }) }).stdout;
  assert.match(out, /worker-stop/);
  assert.doesNotMatch(out, /worktree rm/);
  for (const command of ['echo "orca orchestration worker-release --dispatch ctx_ab12"',
    "cat > spec.md <<'E'\norca orchestration worker-release --dispatch ctx_ab12\nE",
    "node -e \"run('orca orchestration worker-release --dispatch ctx_ab12')\""]) {
    const quiet = spawnSync(process.execPath, [hook], { encoding: 'utf8', input: JSON.stringify({
      tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' } }) }).stdout;
    assert.equal(quiet, '', command);
  }

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'war-')));
  try {
    const main = path.join(tmp, 'main');
    execFileSync('git', ['init', '-q', main]);
    fs.writeFileSync(path.join(main, 'automations.md'), 'a');
    execFileSync('git', ['-C', main, 'add', '-A']);
    execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x']);
    const wt = path.join(tmp, 'wt');
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt]);
    fs.writeFileSync(path.join(wt, 'automations.md'), 'b');
    const line = worktreeAfterRelease.describe('ctx_1', () => JSON.stringify({ ok: true, result: { workspace: `id::${wt}` } }));
    assert.match(line, /1 file chưa commit \(automations\.md\)/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});



test('worker-start-receipt: only a dispatch the command runs is read back', () => {
  const receipt = require('../claude/hooks/worker-start-receipt.cjs');
  const ws = 'worker' + '-start';
  assert.equal(receipt.dispatches(`D=$(orca orchestration ${ws} --spec-file s.md --json)`), true);
  assert.equal(receipt.dispatches(`cd /x && orca orchestration ${ws} --spec-file s.md`), true);
  assert.equal(receipt.dispatches(`printf '%s' '{"command":"D=$(orca orchestration ${ws} --spec-file s.md)"}' | node h.cjs`), false);
  assert.equal(receipt.dispatches(`git commit -m "docs: \\\`orca orchestration ${ws}\\\`"`), false);
});

test('dispatch-split-guard: a claude worker id outside the bare aliases is caught; aliases and other agents pass', () => {
  const g = dispatchSplitGuard;
  const ws = 'orca orchestration ' + 'worker' + '-start --spec-file s.md';
  const pin = (c) => g.unpinnedClaudeModel(c, g.workerStarts(c));
  assert.equal(pin(`${ws} --agent claude --model claude-opus-5-5`), 'claude-opus-5-5');
  assert.equal(pin(`# Model: user chỉ định opus\n${ws} --agent claude --model claude-opus-5-5`), 'claude-opus-5-5', 'no ritual line lets it through');
  assert.equal(pin(`${ws} --agent=claude --model sonnet`), null);
  assert.equal(pin(`${ws} --agent codex --model gpt-sol`), null, 'any agent the coordinator picks');
  assert.equal(pin(`${ws} --agent antigravity --model gemini-3.8-flash --effort high`), null);
});

test('worker-start-receipt: a send to a running worker says the receipt is only the mailbox; to a finished one, where the new dispatch is', () => {
  const receipt = require('../claude/hooks/worker-start-receipt.cjs');
  const states = { ctx_a1: { state: 'running' }, ctx_b2: { state: 'succeeded', released: true, worktree: 'wt1::/w' }, ctx_b3: { state: 'succeeded', released: false }, ctx_b4: { state: 'stopped', released: true, exited: true }, ctx_c3: { state: 'ready' }, ctx_d4: { state: 'ready', exited: true } };
  const lines = (c) => receipt.sendLines(c, (d) => states[d]);
  assert.match(lines('orca orchestration send --to dispatch:ctx_d4 --subject x')[0], /không tới/);
  assert.match(lines('orca orchestration send --to dispatch:ctx_a1 --subject x')[0], /check --peek.*worker-stop --dispatch ctx_a1/);
  assert.doesNotMatch(lines('orca orchestration send --to dispatch:ctx_a1 --subject x')[0], /Cần bạn/);
  assert.match(lines('orca orchestration send --to=dispatch:ctx_c3 --subject x')[0], /state=ready/);
  assert.match(lines('orca orchestration send --to dispatch:ctx_b2 --subject x')[0], /dispatch mới.*worker-list.*wt1::\/w.*không giao thêm worker/);
  assert.deepEqual(lines('orca orchestration send --to dispatch:ctx_b3 --subject x'), [], 'terminal still retained: not seen, silent');
  assert.deepEqual(lines('orca orchestration send --to dispatch:ctx_b4 --subject x'), [], 'other finished states: silent');
  assert.deepEqual(lines('orca orchestration send --to run:run_1 --subject x'), []);
  assert.deepEqual(lines('echo "orca orchestration send --to dispatch:ctx_a1"'), []);
  assert.deepEqual(receipt.sendLines('orca orchestration send --to dispatch:ctx_zz', () => { throw new Error('x'); }), []);
});


test('secret-file-guard: closed blocklist blocks printing secret files or loaded vars and passes other uses', () => {
  const guard = require('../claude/hooks/secret-file-guard.cjs');
  const E = '.e' + 'nv';
  // Stand-in for AgentKit's checkPrivacy on hosts without AgentKit (CI): flags secret-looking file paths.
  const checker = {
    checkPrivacy: ({ toolInput }) => {
      const text = toolInput.command || toolInput.file_path || '';
      const paths = (text.match(/[^\s"'<>]*(\.env[\w.]*|id_ed25519[\w.]*|\.(?:pem|key)|credentials[\w.]*|secrets?\.ya?ml)\b/gi) || [])
        .filter((p) => !/\.(example|sample|template|dist)$/i.test(p));
      return paths.length ? { blocked: true, accesses: paths.map((filePath) => ({ filePath })) } : { blocked: false };
    },
  };
  const userTexts = () => ['cho đọc file env nhé', 'ok'];
  const run = (tool_name, x, opts = { checker, userTexts }) =>
    guard.decide(
      { tool_name, tool_input: tool_name === 'Bash' || tool_name === 'PowerShell' ? { command: x } : { file_path: x }, transcript_path: '/t' },
      opts,
    );

  const allowed = [
    `set -a && . ./${E} && set +a && python3 -I x.py`,
    `set -a && . ./${E} && set +a && python3 -I x.py | grep -v -i -e token -e secret | head -20`,
    `python3 -I x.py ./${E}`,
    `node --env-file=${E} app.js`,
    `cp ${E}.example ${E}`,
    `cat > spec.md <<EOF\nFile ${E}, \`${E}\` and ${E}.\nEOF`,
    `cat > spec.md <<'EOF'\nFile ${E} and server.pem in prose.\nEOF`,
    'ssh -i ~/.ssh/id_ed25519 host',
    'cat ~/.ssh/id_ed25519.pub',
    `source ${E} && psql -c "select 1"`,
    `source ${E} && env FOO=1 python3 x.py`,
    'env FOO=1 python3 x.py',
    `docker compose --env-file ${E} up -d`,
    `uv run --env-file ${E} python -c x`,
    `test -f ${E} && ls -la ${E}`,
    `grep -q DB_URL ${E}`, `grep -c KEY ${E}`, `grep --count K ${E}`, `grep -L K ${E}`,
    `grep ${E} .gitignore`,
    `sed -i 's/A=1/A=2/' ${E}`, `sed 's/\\${E}/x/' README.md`,
    `ps aux | awk '/\\${E}/{print $1}'`,
    `echo "A=1" >> ${E}`, `echo A=1 >${E}`, `echo "không đọc ${E}"`, `source ${E} && echo "done"`,
    `orca orchestration ask --question "chỉ sửa x.sql, không đọc ${E}"`,
    `cat ${E} # secret-ok: "cho đọc file env nhé"`,
    'ls -la',
  ];
  for (const cmd of allowed) assert.equal(run('Bash', cmd), '', cmd);

  const blocked = [
    `cat ${E}`, `CAT ${E}`, `cat < ${E}`, `cat<${E}`, `<${E} cat`, `cat <> ${E}`,
    `head -n 5 ${E}`, `head < ${E}`, `tail ${E}`, `less ${E}`, `more ${E}`, `bat ${E}`,
    `grep KEY ${E}`, `grep -e KEY ${E}`, `grep -- -c ${E}`, `grep -e -c ${E}`, `grep KEY < ${E}`,
    `cut -d= -f2 ${E}`,
    `awk -F= '{print $2}' ${E}`,
    `sed -n '1,5p' ${E}`,
    `base64 ${E}`, `xxd ${E}`, `strings ${E}`,
    `source ${E}; echo $K`, `. ./${E} && printf '%s\\n' "$K"`,
    `source ${E}; env`, `source ${E}; printenv`, `source ${E}; set`,
    `source ${E}; export -p`, `source ${E}; declare -p`,
    `set -x; source ${E}`, `source ${E}; set -x`, `set -v; source ${E}`, `set -o xtrace; . ./${E}`,
    `cat > a.md <<EOF\n$(cat ${E})\nEOF`, `cat > a.md <<EOF\n\`cat ${E}\`\nEOF`, `bash <<'EOF'\ncat ${E}\nEOF`,
    `cat ${E} # secret-ok: "không ai nói câu này"`, `cat ${E} # secret-ok: "ok"`,
    'cat server.pem', 'cat ~/.ssh/id_ed25519', 'head credentials.json',
  ];
  for (const cmd of blocked) assert.match(run('Bash', cmd), /secret-file-guard/, cmd);
  assert.match(run('Bash', `cat ${E}`), /set -a; \. \.\/\.env; set \+a;/);

  for (const ps of [`Get-Content ${E}`, `gc ${E}`, `TYPE ${E}`, `Select-String KEY ${E}`, `sls -Pattern KEY -Path ${E}`])
    assert.match(run('PowerShell', ps), /secret-file-guard/, ps);
  for (const ps of ['Get-ChildItem', `Get-ChildItem ${E}`])
    assert.equal(run('PowerShell', ps), '', ps);

  assert.match(run('Read', E), /secret-file-guard/);
  assert.match(run('Read', 'server.pem'), /secret-file-guard/);
  assert.match(run('Read', '~/.ssh/id_ed25519'), /secret-file-guard/);
  assert.equal(run('Read', '~/.ssh/id_ed25519.pub'), '');
  assert.match(run('Edit', E), /secret-file-guard/);
  assert.equal(run('Write', E), '');
  assert.equal(run('Write', 'server.pem'), '');
  assert.equal(run('Read', 'src/app.js'), '');

  // No checker, or one that throws: fail closed, even a non-printing command is denied, and the reason says why.
  for (const broken of [null, { checkPrivacy: () => { throw new Error('moved'); } }]) {
    assert.match(run('Bash', `source ${E}`, { checker: broken, userTexts }), /did not load or failed/);
    assert.equal(run('Bash', `cat ${E} # secret-ok: "cho đọc file env nhé"`, { checker: broken, userTexts }), '');
    assert.equal(run('Bash', 'ls -la', { checker: broken, userTexts }), '');
  }
  // A command the checker cannot read stays denied, with its reason.
  const opaque = { checkPrivacy: () => ({ blocked: true, uninspectable: true, accesses: [], reason: 'eval of a variable' }) };
  assert.match(run('Bash', 'eval "$X"', { checker: opaque, userTexts }), /eval of a variable/);
});

const KIT_PRIVACY = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'privacy-checker.cjs');
test('secret-file-guard: reality check against installed AgentKit privacy-checker', { skip: !fs.existsSync(KIT_PRIVACY) && 'no AgentKit privacy-checker' }, () => {
  const guard = require('../claude/hooks/secret-file-guard.cjs');
  const E = '.e' + 'nv';
  const userTexts = () => [];
  const run = (tool_name, x) =>
    guard.decide(
      { tool_name, tool_input: tool_name === 'Bash' || tool_name === 'PowerShell' ? { command: x } : { file_path: x }, transcript_path: '/t' },
      { userTexts },
    );

  for (const cmd of [
    `set -a && . ./${E} && set +a && python3 -I x.py`,
    `set -a && . ./${E} && set +a && python3 -I x.py | grep -v secret | head -20`,
    `python3 -I x.py ./${E}`,
    `node --env-file=${E} app.js`,
    `cp ${E}.example ${E}`,
    `cat > spec.md <<EOF\nFile ${E}, \`${E}\` and ${E}.\nEOF`,
    'ssh -i ~/.ssh/id_ed25519 host',
    'cat ~/.ssh/id_ed25519.pub',
  ]) assert.equal(run('Bash', cmd), '', cmd);

  for (const cmd of [`cat ${E}`, `grep KEY ${E}`, `source ${E}; echo $K`, 'cat server.pem', 'cat ~/.ssh/id_ed25519', 'head credentials.json'])
    assert.match(run('Bash', cmd), /secret-file-guard/, cmd);
  assert.match(run('PowerShell', `Get-Content ${E}`), /secret-file-guard/);
  assert.equal(run('PowerShell', 'Get-ChildItem'), '');
  assert.equal(run('PowerShell', `Get-ChildItem ${E}`), '');
  assert.match(run('Read', E), /secret-file-guard/);
  assert.match(run('Read', '~/.ssh/id_ed25519'), /secret-file-guard/);
  assert.equal(run('Read', '~/.ssh/id_ed25519.pub'), '');
});

test('user-intent: userTexts skips entries no human typed (task notifications, other sessions, Orca messages)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-texts-'));
  const t = path.join(tmp, 't.jsonl');
  const line = (content, origin) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...(origin ? { origin } : {}) });
  try {
    const orca = '──── From: TERM_4041-AB (term_4041-ab) (worker_done) ────\nSubject: MR !578 reviewed';
    fs.writeFileSync(t, [line('câu của Viet'), line('gõ tay', { kind: 'human' }), line('Agent finished: chạy xong', { kind: 'task-notification' }),
      line([{ type: 'text', text: orca }])].join('\n'));
    assert.deepEqual(userIntent.userTexts(t), ['câu của Viet', 'gõ tay']);
    assert.equal(userIntent.promptText({ type: 'user', message: { content: orca } }), null, 'an Orca message is not the user\'s words');
    assert.equal(userIntent.promptText({ type: 'user', message: { content: 'ok' } }), 'ok');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('session-notes: once every note of the session is done, the kaizen summary is ordered once', () => {
  const notes = require('../claude/hooks/session-notes.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-close-'));
  const marks = path.join(tmp, 'marks');
  const file = path.join(tmp, 'n.md');
  const second = path.join(tmp, 'm.md');
  const body = (status, eol = '\n') => ['---', 'session: s1', `status: ${status}`, 'scope: x', '---', ''].join(eol);
  try {
    fs.writeFileSync(file, body('open'));
    assert.deepEqual(notes.closedNote([{ file }], 's1', marks), []);
    // Closed however it was written: CRLF and a quoted value read as done.
    fs.writeFileSync(file, body('"done"', '\r\n'));
    fs.writeFileSync(second, body('open'));
    assert.deepEqual(notes.closedNote([{ file }, { file: second }], 's1', marks), [], 'one note still open');
    fs.writeFileSync(second, body('done # wrapped up'));
    assert.deepEqual(notes.closedNote([{ file }, { file: second }], 's1', marks), [file, second].sort());
    assert.deepEqual(notes.closedNote([{ file }, { file: second }], 's1', marks), [], 'only once per session');
    assert.deepEqual(notes.closedNote([{ file }], 's2', marks), [file], 'another session has its own mark');
    assert.match(notes.kaizenReminder([file], '/p/s1.jsonl'), /\/p\/s1\.jsonl, not your memory/);
    // Only what a hook, script, skill or reworded sentence must fix is listed: a clear rule broken without harm is no file.
    for (const kind of [/only what a hook, script, skill or reworded sentence must fix/, /a harness defect met/,
      /a serious break no hook stops yet .*its fix is a hook, never a sentence/, /two fair readings of which lead to two different actions/])
      assert.match(notes.kaizenReminder([file]), kind);
    assert.match(notes.kaizenReminder([file]), /clear rule broken without such harm, or an intent misread, is no file/);
    assert.doesNotMatch(notes.kaizenReminder([file]), /every correction from Viet/);
    // A note this session wrote without its id on the session: line is named; its own note, a done
    // one, a file with no front matter or one outside the notes folder is not.
    const write = (f) => ({ tool_name: 'Write', tool_input: { file_path: f } });
    const other = path.join(tmp, 'other.md');
    fs.writeFileSync(other, body('open').replace('s1', 'current'));
    assert.equal(notes.strayNote(write(other), [{ file }], tmp), other);
    assert.equal(notes.strayNote(write(file), [{ file }], tmp), '');
    fs.writeFileSync(other, body('done'));
    assert.equal(notes.strayNote(write(other), [{ file }], tmp), '');
    fs.writeFileSync(other, '# just a heading\n');
    assert.equal(notes.strayNote(write(other), [{ file }], tmp), '');
    assert.equal(notes.strayNote(write(path.join(os.tmpdir(), 'elsewhere.md')), [{ file }], tmp), '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main-checkout-guard: a repo in the session scratchpad is a fixture, made or not yet; other repos stay gated', () => {
  const root = fs.realpathSync(os.tmpdir());
  const base = path.join(root, `claude-${process.pid}`);
  const sp = path.join(base, 'proj', 'sess', 'scratchpad');
  const other = path.join(base, 'proj', 'sess', 'not-scratch');
  const S = sp.split(path.sep).join('/');
  try {
    for (const d of [path.join(sp, 'repo'), path.join(other, 'repo')]) {
      execFileSync('git', ['init', '-q', d]);
      execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x', '--allow-empty']);
    }
    const writes = (command, cwd = root) => mainCheckoutGuard.writesMainCheckout(command, cwd);
    for (const c of [
      `cd "${S}" && rm -rf g && mkdir g && cd g && git init -q && git -c user.name=t commit -qm i`,
      `S="${S}"; cd $S/new && git commit -qm i`,
      `git -C "${S}/repo" commit -qm x --allow-empty`,
    ]) assert.equal(writes(c), false, c);
    assert.equal(writes('git commit -qm x --allow-empty', path.join(sp, 'repo')), false, 'cwd in the scratchpad');
    for (const d of ['/tmp/claude-501/p/s/scratchpad/x', '/private/tmp/claude-501/p/s/scratchpad']) assert.ok(mainCheckoutGuard.inScratchpad(d), d);
    for (const d of ['/tmp/claude-501/p/scratchpad', '/tmp/claude-501/p/s/scratchpadX', '/tmp/x/claude-501/p/s/scratchpad', '/Users/u/claude-1/p/s/scratchpad'])
      assert.equal(mainCheckoutGuard.inScratchpad(d), false, d);
    for (const c of [
      `git -C "${other.split(path.sep).join('/')}/repo" commit -qm x`,
      `cd "${S}/../not-scratch/repo" && git reset --hard`,
      `cd "${S}" && cd "${root.split(path.sep).join('/')}/no-such-dir" && git checkout main`,
    ]) assert.equal(writes(c), true, c);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('tier-c-guard: a production write runs alone, never after another step of the same call', () => {
  for (const c of [
    "ssh box1 'sudo app.enable-https lets-encrypt 2>&1 | tail -3' && cf tunnels config update abc --body x",
    'git fetch && gh pr merge 30 --squash',
    'a | tail; glab mr merge 5',
    'bash -c "x | tail && cf dns records create z"',
    'make build && wrangler deploy',
    'ls && cf --profile work dns records create x',
    'npm run build | tail -5 && npx wrangler deploy',
    'npm test && gh -R o/r pr merge 31',
    'npm run build && wrangler d1 migrations apply DB --remote',
    'gh pr merge 1 --squash; gh pr merge 2 --squash',
    '(a | tail) && cf tunnels config update x',
    '(cd app && npm run build | tail -3 && wrangler deploy)',
    'echo $(npm run build && wrangler deploy)',
    'npm run build && npx wrangler@latest deploy',
    'x && npm exec -- wrangler deploy',
    'x && pnpm --filter web exec wrangler deploy',
  ]) assert.ok(tierCGuard.chainedProdWrite(c), c);
  for (const c of [
    'cf tunnels config update abc --body x',
    'cd repo && gh pr merge 30',
    'X=1; cf dns records delete r',
    'cf tunnels config update a && cf tunnels list',
    'cf dns records list --name update',
    "ssh h 'a | tail'",
    'gh pr view 30 && gh pr checks 30',
    'echo "a | tail && cf tunnels config update x"',
    'GH_TOKEN=$(gh auth token --user u) gh pr merge 31 --squash',
    'export GH_TOKEN=$(gh auth token --user u); gh pr merge 31',
    'ls && cf --profile work dns records list --name update',
    'CLOUDFLARE_API_TOKEN=$(x) npx wrangler deploy',
    '(cd app && wrangler deploy)',
  ]) assert.equal(tierCGuard.chainedProdWrite(c), null, c);
  const r = spawnSync(process.execPath, [path.join(HOOKS_DIR, 'tier-c-guard.cjs')], { encoding: 'utf8', input: JSON.stringify({
    tool_name: 'Bash', transcript_path: path.join(os.tmpdir(), 'no-such.jsonl'),
    tool_input: { command: 'ssh h "a | tail -3" && cf tunnels config update abc' } }) });
  assert.equal(r.status, 2, 'a chained write is blocked whatever the user said');
  assert.match(r.stderr, /run the write alone/);
});


test('tier-c-guard: an Orca message is not the user\'s words; a trigger on the schedule config and a merge are not tier C', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tierc-'));
  const t = path.join(tmp, 't.jsonl');
  const user = (content) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const orca = '──── From: TERM_4041-AB (term_4041-ab) (worker_done) ────\nSubject: MR !578 reviewed: 0 blocking findings, ready to merge?';
  const run = (command, lines) => {
    fs.writeFileSync(t, lines.join('\n') + '\n');
    return spawnSync(process.execPath, [path.join(HOOKS_DIR, 'tier-c-guard.cjs')], { encoding: 'utf8', input: JSON.stringify({
      tool_name: 'Bash', session_id: 'tierc-test', cwd: tmp, transcript_path: t, tool_input: { command } }) });
  };
  try {
    const trigger = "ssh vps 'docker exec sched airflow dags trigger ing_shopify_orders'";
    assert.equal(run(trigger, [user('sao chưa chạy?')]).status, 0, 'the schedule config is not tier C');
    const conf = "ssh vps 'docker exec sched airflow dags trigger ing_x --conf \"{\\\"a\\\":1}\"'";
    assert.equal(run(conf, [user('ok'), user([{ type: 'text', text: orca }])]).status, 0, 'the latest words are Viet\'s "ok", not the worker\'s');
    const asked = run(conf, [user('sao chưa chạy?')]);
    assert.equal(asked.status, 2);
    assert.match(asked.stderr, /question/);
    assert.equal(run("ssh vps 'airflow dags unpause mdl_x'", [user('bật lại thì sao?')]).status, 2);
    assert.equal(run('gh pr merge 31 --squash', [user('merge chưa?')]).status, 0, 'a merge is judged by its deploy, not here');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('secret-file-guard: loading a dotenv then echoing an exit code or an unrelated variable passes; echoing one of its keys does not', () => {
  const { printedSecrets } = require('../claude/hooks/secret-file-guard.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfg-'));
  fs.writeFileSync(path.join(tmp, '.env'), 'API_KEY=x\nexport DB_URL=y\n');
  const isSecret = (f) => path.basename(f) === '.env';
  const leak = (c) => printedSecrets(c, isSecret, tmp);
  try {
    for (const c of [
      'set -a && . ./.env && set +a && python3 -I x.py > out.txt 2>&1; echo exit=$?; tail -3 out.txt; wc -l < log.jsonl',
      'set -a; . ./.env; set +a; python3 x.py; echo "rows=$N $1"',
    ]) assert.deepEqual(leak(c), [], c);
    for (const c of ['set -a; . ./.env; echo $API_KEY', 'set -a; . ./.env; printf "%s" "${DB_URL}"', 'set -a; . ./.env; env', 'set -x; . ./.env', 'tail -3 .env'])
      assert.deepEqual(leak(c), c.startsWith('tail') ? ['.env'] : ['./.env'], c);
    assert.deepEqual(printedSecrets('. ./.env; echo $ANY', isSecret, path.join(tmp, 'missing')), ['./.env'], 'an unreadable file counts every variable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('session-notes: a write that drops another session id from the session: line is told to put it back', () => {
  const { droppedIds } = require('../claude/hooks/session-notes.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
  const file = path.join(root, 'slug', 'n.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const note = (ids) => `---\nsession: ${ids}\nstatus: open\nscope: x\n---\n\n## Đang làm\n\n- a\n`;
  try {
    fs.writeFileSync(file, note('bbb'));
    const data = { tool_name: 'Edit', tool_input: { file_path: file }, tool_response: { originalFile: note('aaa, bbb') } };
    assert.deepEqual(droppedIds(data, root), ['aaa']);
    fs.writeFileSync(file, note('aaa, bbb'));
    assert.deepEqual(droppedIds(data, root), [], 'appending keeps every id');
    assert.deepEqual(droppedIds({ ...data, tool_response: {} }, root), [], 'no earlier file: nothing to compare');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watch-guard: a loop inside `bash -c`, `sh -c` or `eval` is this shell\'s loop', () => {
  const { shape } = require('../claude/hooks/watch-guard.cjs');
  assert.equal(shape("nohup bash -c 'while true; do sleep 5; done' &").wait, true);
  assert.equal(shape("sh -c 'sleep 600; gh pr checks 1'").sleeps, true);
  assert.equal(shape("bash -c 'until curl -sf x; do sleep 2; done'").poll, true);
  const remote = shape("bash -c 'for h in a b; do ssh $h x; done'");
  assert.equal(remote.loop && remote.remote, true);
  assert.equal(shape("eval 'while true; do sleep 1; done'").poll, true);
  assert.equal(shape("ssh host 'for f in *; do cat $f; done'").loop, false, 'a script for another machine is one remote call');
});

test('secret-file-guard: a relative dotenv loaded after a `cd` counts every variable an echo names', () => {
  const { printedSecrets } = require('../claude/hooks/secret-file-guard.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfg-cd-'));
  for (const [d, key] of [['a', 'A_KEY'], ['b', 'B_TOKEN']]) {
    fs.mkdirSync(path.join(tmp, d));
    fs.writeFileSync(path.join(tmp, d, '.env'), `${key}=x\n`);
  }
  const isSecret = (f) => path.basename(f) === '.env';
  const leak = (c) => printedSecrets(c, isSecret, path.join(tmp, 'a'));
  try {
    assert.deepEqual(leak('cd ../b && source .env && echo $B_TOKEN'), ['.env']);
    assert.deepEqual(leak('env -C ../b true; source .env; echo $B_TOKEN'), ['.env']);
    assert.deepEqual(leak('cd ../b && set -a && . ./.env && set +a && python3 x.py; echo exit=$?'), [], 'no variable named');
    assert.deepEqual(leak('source .env && echo $B_TOKEN'), [], 'the cwd file does not set it');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('secret-file-guard: a dotenv loaded with `set -a` then used by curl inside `$(…)` passes, after a literal `cd` too', () => {
  const { printedSecrets } = require('../claude/hooks/secret-file-guard.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfg-subst-'));
  fs.mkdirSync(path.join(tmp, 'app'));
  fs.writeFileSync(path.join(tmp, 'app', '.env'), 'SUPABASE_URL=x\nSERVICE_KEY=y\n');
  fs.writeFileSync(path.join(tmp, '.env'), 'DATABASE_URL=z\n');
  const isSecret = (f) => path.basename(f) === '.env';
  const leak = (c) => printedSecrets(c, isSecret, tmp);
  const load = 'cd app && set -a; . ./.env; set +a; ';
  const root = 'set -a; . ./.env; set +a; echo "db=$DATABASE_URL"';
  try {
    for (const c of [
      load + 'H=(-H "apikey: $SERVICE_KEY"); U=$SUPABASE_URL\nfor e in a@example.com; do\n  echo "=== $e"\n' +
        '  id=$(curl -s "${H[@]}" "$U/rest/v1/rpc/find" -d "{\\"p\\":\\"$e\\"}" | tr -d \'"\')\n  echo "user_id: $id"\n' +
        '  echo "orders: $(curl -s "${H[@]}" "$U/rest/v1/orders?email=eq.$e" | python3 -c "import json,sys;print(json.load(sys.stdin))")"\ndone',
      load + 'echo "n: `curl -s $SUPABASE_URL`"',
      load + 'echo "n: $(curl -s "$(date)" -H "k: $SERVICE_KEY")"',
      `cd "${path.join(tmp, 'app').replace(/\\/g, '/')}" && set -a; . ./.env; set +a; echo "x $e"`,
      'cd app; cd ..; cd app && . ./.env; echo "$OTHER"',
    ]) assert.deepEqual(leak(c), [], c);
    for (const c of [
      load + 'echo "$SERVICE_KEY"',
      load + 'U=$SUPABASE_URL; echo "$U"',
      load + 'echo "$(echo $SERVICE_KEY)"',
      'cd "$D" && . ./.env; echo "$e"',
      'cd - && . ./.env; echo "$e"',
      'env -C /x true; cd app && . ./.env; echo "$e"',
      load + 'echo "v: $(echo "$v" | sed \'s/ (.*//\') k=$SERVICE_KEY"',
      load + 'echo "$(( $SERVICE_KEY + 1 ))"',
      '(cd app && npm ci); ' + root,
      'D=$(cd app && pwd); ' + root,
      'pushd app >/dev/null; npm run build; popd >/dev/null; ' + root,
      'cd app && (set -a; . ./.env; set +a; echo "k=$SERVICE_KEY")',
    ]) assert.deepEqual(leak(c), ['./.env'], c);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('user-intent: every Orca message header is not the user\'s words, whatever its priority or type', () => {
  for (const text of [
    '──── From: TERM_4041-AB (term_4041-ab) (worker_done) ────\nSubject: x',
    '──── From: TERM_4041-AB (term_4041-ab) [HIGH] (escalation) ────\nCó pause DAG không?',
    '──── From: TERM_4041-AB (term_4041-ab) ────\nxin chỉ thị',
  ]) assert.equal(userIntent.promptText({ type: 'user', message: { content: text } }), null, text);
  assert.equal(userIntent.promptText({ type: 'user', message: { content: 'From: Viet, ok làm đi' } }), 'From: Viet, ok làm đi');
});

test('dispatch-split-guard: the model and the effort reminders are each said once for the same command', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsg-keys-'));
  const t = path.join(tmp, 't.jsonl');
  fs.writeFileSync(t, JSON.stringify({ type: 'user', message: { role: 'user', content: 'giao worker đi' } }) + '\n');
  const session = `dsg-keys-${process.pid}-${Date.now()}`;
  const spec = '--spec "Rà; chạy orca orchestration check --peek sau mỗi 10 lệnh"';
  const both = `orca orchestration worker-start ${spec} --agent antigravity --model gemini-3.8-flash` +
    ` ; orca orchestration worker-start ${spec} --agent claude --model claude-opus-5-5`;
  const run = () => spawnSync(process.execPath, [path.join(HOOKS_DIR, 'dispatch-split-guard.cjs')], { encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Bash', session_id: session, transcript_path: t, cwd: tmp, tool_input: { command: both } }) });
  try {
    const first = run();
    assert.equal(first.status, 2);
    assert.match(first.stderr, /bare alias/);
    const second = run();
    assert.equal(second.status, 2, 'the effort reminder still comes once');
    assert.match(second.stderr, /--effort/);
    assert.equal(run().status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('secret-file-guard: a variable set from a dotenv key carries it', () => {
  const { printedSecrets } = require('../claude/hooks/secret-file-guard.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfg-alias-'));
  fs.writeFileSync(path.join(tmp, '.env'), 'A_KEY=x\n');
  const leak = (c) => printedSecrets(c, (f) => path.basename(f) === '.env', tmp);
  try {
    assert.deepEqual(leak('source .env; X=$A_KEY; echo $X'), ['.env']);
    assert.deepEqual(leak('source .env; export Y="${A_KEY}"; Z=$Y; printf "%s" "$Z"'), ['.env']);
    assert.deepEqual(leak('source .env; N=3; echo $N'), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main-checkout-guard: core.hooksPath counts only when git runs with it', () => {
  const { hooksOff } = mainCheckoutGuard;
  for (const c of ['git -c core.hooksPath=/dev/null commit -m x', 'git -C r -c core.hookspath=x push', 'bash -c "git -c core.hooksPath=x commit"'])
    assert.equal(hooksOff(c), true, c);
  for (const c of ['git commit -m "never run git -c core.hooksPath=/dev/null"', 'echo git -c core.hooksPath=x', 'git -c user.name=x commit'])
    assert.equal(hooksOff(c), false, c);
});

test('watch-guard: no timeout advice when the call already has the longest timeout', () => {
  const s = `wg-max-${process.pid}-${Date.now()}`;
  const run = (input) => spawnSync(process.execPath, [path.join(HOOKS_DIR, 'watch-guard.cjs')], { encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Bash', session_id: s, cwd: os.tmpdir(), tool_input: input }) });
  const w = '~/.claude/scripts/watch.sh --check "x" --ok done --wait running --checkpoint 7200';
  assert.equal(run({ command: w, run_in_background: true, timeout: 7200000 }).status, 0);
});

test('push-after-pr-guard: a bare push goes to the branch push remote, then remote.pushDefault, then its remote', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'papg-remote-'));
  const git = (...a) => execFileSync('git', ['-C', tmp, ...a], { encoding: 'utf8' });
  // The remote it picks is the one whose URL it reads: a remote that does not exist names itself in the error.
  // The hook's 12 s deadline starts when its module loads (one hook call = one process): load a fresh copy.
  const modPath = require.resolve('../claude/hooks/push-after-pr-guard.cjs');
  const fresh = () => { delete require.cache[modPath]; return require(modPath); };
  const picked = () => { try { fresh().reviewsFor(tmp, null, 'feat', { glab: () => [], gh: () => [] }); return 'ok'; } catch (e) { return String(e.message); } };
  try {
    execFileSync('git', ['init', '-q', tmp]);
    git('config', 'branch.feat.remote', 'by-branch');
    assert.match(picked(), /by-branch/);
    git('config', 'remote.pushDefault', 'by-default');
    assert.match(picked(), /by-default/);
    git('config', 'branch.feat.pushRemote', 'by-push-remote');
    assert.match(picked(), /by-push-remote/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('main-checkout-guard: removing a detached worktree is flagged only when no ref holds its commits', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcg-rm-'));
  const git = (...a) => execFileSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
  try {
    execFileSync('git', ['init', '-q', tmp]);
    git('commit', '-qm', 'x', '--allow-empty');
    const lone = path.join(tmp, 'lone');
    const atMain = path.join(tmp, 'at-main');
    const onBranch = path.join(tmp, 'on-branch');
    git('worktree', 'add', '-q', '--detach', lone);
    execFileSync('git', ['-C', lone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'only here', '--allow-empty']);
    git('worktree', 'add', '-q', '--detach', atMain);
    git('worktree', 'add', '-q', '-b', 'side', onBranch);
    const writes = (c) => mainCheckoutGuard.writesMainCheckout(c, tmp);
    const P = (p) => p.split(path.sep).join('/');
    assert.equal(writes(`git worktree remove "${P(lone)}"`), true, 'its commit goes with it');
    assert.equal(writes('git worktree remove lone'), true, 'a path relative to the checkout');
    assert.equal(writes(`git worktree remove "${P(atMain)}"`), false, 'a branch holds its commit');
    assert.equal(writes(`git worktree remove "${P(onBranch)}"`), false, 'on a branch');
    assert.equal(writes(`git -C "${P(onBranch)}" worktree remove "${P(lone)}"`), false, 'run from a linked worktree');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mcg-ws-'));
    try {
      const away = path.join(ws, 'away');
      git('worktree', 'add', '-q', '--detach', away);
      execFileSync('git', ['-C', away, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'only here', '--allow-empty']);
      assert.equal(writes('git worktree remove away'), true, 'a worktree outside the checkout, named by its ending');
      assert.equal(writes(`git worktree remove ${path.basename(ws)}/away/`), true, 'a longer ending');
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
    // `git pull <remote> <branch>` of the branch's own upstream is upkeep; another branch is a merge.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mcg-bare-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', bare]);
      const head = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      git('remote', 'add', 'origin', bare);
      git('push', '-q', '-u', 'origin', head);
      assert.equal(writes(`git pull origin ${head}`), false, 'its own upstream');
      assert.equal(writes(`git pull --rebase origin ${head}`), false, 'its own upstream, rebased');
      assert.equal(writes('git pull origin other'), true, 'another branch');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

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
const gateLineGuard = require('../claude/hooks/gate-line-guard.cjs');
const rulesBudget = require('../claude/hooks/rules-budget.cjs');
const watchGuard = require('../claude/hooks/watch-guard.cjs');
const pushAfterPrGuard = require('../claude/hooks/push-after-pr-guard.cjs');
const workerDefaultGuard = require('../claude/hooks/worker-default-guard.cjs');
const dispatchSplitGuard = require('../claude/hooks/dispatch-split-guard.cjs');
const noteRecall = require('../claude/hooks/note-recall.cjs');
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
  await t.test('gate-line-guard: resolveDir handles ~ with / and \\', () => {
    const posixBase = '/Users/test/workspace';
    const winBase = 'C:\\Users\\test\\workspace';

    const p1 = gateLineGuard.resolveDir('sub/dir', posixBase);
    assert.ok(p1.includes('sub'));

    const p2 = gateLineGuard.resolveDir('~', posixBase);
    assert.equal(p2, path.resolve(os.homedir()));

    const p3 = gateLineGuard.resolveDir('~/sub', posixBase);
    assert.equal(p3, path.resolve(os.homedir(), 'sub'));

    const p4 = gateLineGuard.resolveDir('~\\sub', winBase);
    assert.ok(platform.samePath(p4, path.resolve(os.homedir(), 'sub')));
  });

  await t.test('rules-budget: isMine and isNote handle Windows and POSIX paths', () => {
    const home = os.homedir();
    const mineFile = path.join(home, '.claude', 'rules', 'mine', 'custom.md');
    assert.ok(rulesBudget.isMine(mineFile));

    const noteFile = path.join(home, '.claude', 'session-notes', 'slug', 'note.md');
    assert.ok(rulesBudget.isNote(noteFile));

    assert.ok(!rulesBudget.isMine(path.join(home, '.claude', 'CLAUDE.md')));
    assert.ok(!rulesBudget.isNote(path.join(home, '.claude', 'rules', 'mine', 'note.md')));
  });

  await t.test('worker-default-guard: inside() handles path casing on win32', () => {
    const claudeDir = path.join(os.homedir(), '.claude');
    const childFile = path.join(claudeDir, 'rules', 'mine', 'test.md');
    assert.ok(workerDefaultGuard.inside(childFile, claudeDir));
    assert.ok(!workerDefaultGuard.inside('/other/repo/file.txt', claudeDir));
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

  await t.test('note-recall: tokens() extracts program names across slash formats', () => {
    const t1 = noteRecall.tokens('/usr/local/bin/my-command --flag');
    assert.ok(t1.names.includes('my-command'));

    const t2 = noteRecall.tokens("'C:\\tools\\my-tool.exe' --flag");
    assert.ok(t2.names.includes('my-tool.exe'));

    const t3 = noteRecall.tokens("'.\\scripts\\runner.sh' start");
    assert.ok(t3.names.includes('runner.sh'));
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
    assert.deepEqual(one('git push 2>&1 | tail -3'), [{ dir: base, remote: 'origin', refspecs: [] }]);
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

  await t.test('push-after-pr-guard: a push whose directory cannot be known is voiced as such', () => {
    const reviews = () => { throw new Error('must not be asked'); };
    const r = pushAfterPrGuard.decide('cd $UNSET && git push origin feat', '/r', { reviews, branches: (p) => p.refspecs });
    assert.match(r.blind[0], /không xác định được thư mục của `git push`/);
    const gone = pushAfterPrGuard.decide('cd /no/such/dir/xyz && git push origin feat', '/r');
    assert.match(gone.blind[0], /"feat" \(origin\): thư mục .*xyz không tồn tại/);
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
    // Case A: gate-line-guard with git mutation on main checkout without Gate:
    await t.test('gate-line-guard POSIX payload behavior', () => {
      const payload = {
        tool_name: 'Bash',
        tool_input: { command: 'git checkout main' },
        cwd: tmpTestDir,
        session_id: 'compat-test-session',
        transcript_path: emptyTranscript,
      };

      const newHook = path.join(HOOKS_DIR, 'gate-line-guard.cjs');
      const newRes = spawnSync(process.execPath, [newHook], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 5000,
      });

      if (mainHooksDir && fs.existsSync(path.join(mainHooksDir, 'gate-line-guard.cjs'))) {
        const oldHook = path.join(mainHooksDir, 'gate-line-guard.cjs');
        const oldRes = spawnSync(process.execPath, [oldHook], {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(newRes.status, oldRes.status);
      } else {
        assert.equal(newRes.status, 0); // fails open or passes since tmpTestDir is not a main git checkout
      }
    });

    // Case B: worker-default-guard with a real file inside .claude (exempt). Not CLAUDE.md: it may
    // symlink into the harness repo, which is judged by where it leads.
    await t.test('worker-default-guard POSIX payload behavior', () => {
      const claudeFile = path.join(os.homedir(), '.claude', 'session-notes', 'compat-test.md');
      const payload = {
        tool_name: 'Write',
        tool_input: { file_path: claudeFile, content: 'test' },
        cwd: tmpTestDir,
        session_id: 'compat-test-session',
        transcript_path: emptyTranscript,
      };

      const newHook = path.join(HOOKS_DIR, 'worker-default-guard.cjs');
      const newRes = spawnSync(process.execPath, [newHook], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        timeout: 5000,
      });

      if (mainHooksDir && fs.existsSync(path.join(mainHooksDir, 'worker-default-guard.cjs'))) {
        const oldHook = path.join(mainHooksDir, 'worker-default-guard.cjs');
        const oldRes = spawnSync(process.execPath, [oldHook], {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(newRes.status, oldRes.status);
      }
      assert.equal(newRes.status, 0);
    });

    // Case C: rules-budget with small edit to a mine rule file under budget
    await t.test('rules-budget POSIX payload behavior', () => {
      const mineFile = path.join(os.homedir(), '.claude', 'rules', 'mine', 'communication-style.md');
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
        'Không dùng --dry-run, chạy thật lark-cli base +record-delete', 'lark-cli api --as user POST /open-apis/x'];
      const miss = ['lark-cli base +record-batch-update --dry-run --json @a.json', 'KHÔNG chạy +record-delete',
        'đừng gọi n8n_create_workflow', 'lark-cli base +field-list --table t', 'lark-cli api GET /open-apis/x',
        'lark-cli base +field-search-options --x', 'lark-cli base +dashboard-block-get-data', 'n8n_get_workflow id=1',
        'git push --set-upstream origin x', '+on-update', 'n8n_workflow_versions mode=list'];
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

test('coordinator-read-guard: a third read of a watched place in one turn needs a worker', async (t) => {
  const guard = require('../claude/hooks/coordinator-read-guard.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-reads-'));
  const repos = path.join(tmp, 'umb', 'repos');
  // Bash command strings use forward slashes: a shell reads `\` as an escape (Git Bash on Windows too).
  const sh = (p) => p.split(path.sep).join('/');
  fs.mkdirSync(path.join(repos, 'app'), { recursive: true });
  const listFile = path.join(tmp, 'list.txt');
  fs.writeFileSync(listFile, `# watched\n${sh(repos)}\ncmd:ssh\n`);
  const list = guard.watched(listFile);
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'bảng X đã có chưa' } })}\n`);
  const notesDir = path.join(tmp, 'notes');
  fs.mkdirSync(notesDir);
  let n = 0;
  const session = () => `coord-test-${process.pid}-${n}`;
  // A call that passes PreToolUse runs, so PostToolUse counts it; `pre` alone is a call another
  // PreToolUse hook denied (it never runs, no PostToolUse).
  // Each call is 10 s after the last (the model writes one call after another), unless `at` pins it.
  let clock = 0;
  const pre = (tool_name, tool_input, extra = {}, at) =>
    guard.decide({ session_id: session(), transcript_path: transcript, cwd: path.join(tmp, 'umb'), tool_name, tool_input, ...extra },
      { list, notesDir, now: at ?? (clock += 10000) });
  const call = (tool_name, tool_input, extra = {}) => {
    const why = pre(tool_name, tool_input, extra);
    if (!why) pre(tool_name, tool_input, { ...extra, hook_event_name: 'PostToolUse' });
    return why;
  };
  const turn = () => { n++; guard.decide({ session_id: session(), hook_event_name: 'UserPromptSubmit' }, { list }); };

  try {
    await t.test('two reads pass, the third is denied', () => {
      turn();
      assert.equal(call('Bash', { command: 'git -C repos/app grep -n foo' }), '');
      assert.equal(call('Read', { file_path: path.join(repos, 'app', 'a.sql') }), '');
      assert.match(call('Grep', { pattern: 'x', path: 'repos/app' }), /read 3 of a watched place/);
    });

    await t.test('a call another hook denied (no PostToolUse) is not counted', () => {
      turn();
      assert.equal(pre('Bash', { command: `git -C "${sh(repos)}/app" grep -n foo` }), '');
      assert.equal(call('Bash', { command: `cat "${sh(repos)}/app/x"` }), '');
      assert.equal(call('Bash', { command: `cat "${sh(repos)}/app/y"` }), '');
      assert.match(call('Bash', { command: `cat "${sh(repos)}/app/z"` }), /read 3 of a watched place/);
    });

    await t.test('reads sent in parallel count while pending: the third is denied', () => {
      turn();
      const at = (clock += 10000);
      const ids = ['a', 'b', 'c', 'd'].map((x) => ({ tool_use_id: `tu_${x}` }));
      const got = ['a', 'b', 'c', 'd'].map((x, i) => pre('Read', { file_path: path.join(repos, 'app', x) }, ids[i], at + i));
      assert.deepEqual(got.map(Boolean), [false, false, true, true]);
      for (const i of [0, 1]) pre('Read', { file_path: path.join(repos, 'app', 'ab'[i]) }, { ...ids[i], hook_event_name: 'PostToolUse' });
      assert.notEqual(call('Read', { file_path: path.join(repos, 'app', 'e') }), '');
    });

    await t.test('a failed worker-start does not unlock the turn', () => {
      turn();
      const ws = 'orca orchestration worker-start --spec-file bad.md --worktree path:/x';
      pre('Bash', { command: ws });
      pre('Bash', { command: ws }, { hook_event_name: 'PostToolUseFailure' });
      call('Bash', { command: `cat "${sh(repos)}/app/a"` });
      call('Bash', { command: `cat "${sh(repos)}/app/b"` });
      assert.notEqual(call('Bash', { command: `cat "${sh(repos)}/app/c"` }), '');
    });

    await t.test('a command that creates a path is not counted when it ran', () => {
      turn();
      const inRepo = { cwd: path.join(repos, 'app') };
      const made = { 'mkdir newdir': () => fs.mkdirSync(path.join(repos, 'app', 'newdir')), 'touch newfile': () => fs.writeFileSync(path.join(repos, 'app', 'newfile'), '') };
      for (const [c, make] of Object.entries(made)) {
        assert.equal(pre('Bash', { command: c }, inRepo), '');
        make();
        pre('Bash', { command: c }, { ...inRepo, hook_event_name: 'PostToolUse' });
      }
      call('Bash', { command: `cat "${sh(repos)}/app/a"` });
      assert.equal(call('Bash', { command: `cat "${sh(repos)}/app/b"` }), '');
    });

    await t.test('a failed call (PostToolUseFailure) still counts: it ran', () => {
      turn();
      for (const c of [`cat "${sh(repos)}/app/nope1"`, `cat "${sh(repos)}/app/nope2"`]) {
        assert.equal(pre('Bash', { command: c }), '');
        pre('Bash', { command: c }, { hook_event_name: 'PostToolUseFailure' });
      }
      assert.notEqual(pre('Bash', { command: `cat "${sh(repos)}/app/nope3"` }), '');
    });

    await t.test('a worker-start another hook denied does not unlock the turn', () => {
      turn();
      pre('Bash', { command: 'orca orchestration worker-start --spec-file s.md --worktree path:/x' });
      call('Bash', { command: `cat "${sh(repos)}/app/a"` });
      call('Bash', { command: `cat "${sh(repos)}/app/b"` });
      assert.notEqual(call('Bash', { command: `cat "${sh(repos)}/app/c"` }), '');
    });

    await t.test('git <rev>:<path> reads the path from the repo of -C or cwd', () => {
      turn();
      const repo = path.join(repos, 'gitrepo');
      fs.mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', repo]);
      call('Bash', { command: `git -C "${sh(repo)}" show :2:README.md` }, { cwd: tmp });
      call('Bash', { command: 'git show HEAD:README.md' }, { cwd: repo });
      assert.notEqual(call('Bash', { command: 'git show origin/main:a/b.sql' }, { cwd: repo }), '');
      turn();
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'git show HEAD:README.md' }, { cwd: tmp }), '');
      for (const c of ['git clone https://x.example/r.git', 'git clone git@github.com:org/r.git /tmp/elsewhere',
        'git remote add up git@gitlab.com:grp/r.git', 'git ls-remote git@github.com:org/r.git', 'git config remote.origin.url git@host:o/r',
        'git -c user.name=a:b status', 'git log --oneline --grep fix:bug', 'git show :/fix message']) {
        assert.equal(call('Bash', { command: c }, { cwd: repo }), '', c);
      }
    });

    await t.test('a Read of a file in a repo the note claims passes; unclaimed it is counted', () => {
      const repo = path.join(repos, 'claimed');
      fs.mkdirSync(repo, { recursive: true });
      execFileSync('git', ['init', '-q', repo]);
      fs.writeFileSync(path.join(repo, 'README.md'), 'x');
      turn();
      const note = path.join(notesDir, 'd', 'n.md');
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok merge tuần tự đi nhé' } })}\n`);
      fs.writeFileSync(note, `---\nsession: ${session()}\nstatus: open\n---\n## Đang có hiệu lực\n- Người làm: Claude — claimed — "ok merge tuần tự đi"\n`);
      for (let i = 0; i < 3; i++) assert.equal(call('Read', { file_path: path.join(repo, 'README.md') }), '');
      fs.rmSync(note);
      call('Read', { file_path: path.join(repo, 'README.md') });
      call('Read', { file_path: path.join(repo, 'README.md') });
      assert.notEqual(call('Read', { file_path: path.join(repo, 'README.md') }), '');
    });

    await t.test('a Người làm line opens ssh by the command, its host, a list or `*`; a wrong quote or place does not', () => {
      const note = path.join(notesDir, 'd', 'n.md');
      fs.mkdirSync(path.dirname(note), { recursive: true });
      fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ssh vào web1 rồi tự check nhé' } })}\n`);
      const threeReads = (place, quote = 'ssh vào web1 rồi tự check') => {
        turn();
        fs.writeFileSync(note, `---\nsession: ${session()}\nstatus: open\n---\n## Đang có hiệu lực\n- Người làm: Claude — ${place} — "${quote}"\n`);
        return [1, 2, 3].map((i) => call('Bash', { command: `ssh deploy@web1:22 docker logs app --tail ${i}` }));
      };
      for (const place of ['ssh', 'web1', 'repo_a, web1', '*']) assert.deepEqual(threeReads(place), ['', '', ''], place);
      assert.notEqual(threeReads('web2')[2], '');
      assert.notEqual(threeReads('ssh', 'câu này không có trong phiên')[2], '');
      assert.notEqual(threeReads('docker', 'ssh vào web1 rồi tự check')[2], '', 'only the host operand counts');
      // A `→` value line is no quote: it never opens a read, `*` included.
      turn();
      fs.writeFileSync(note, `---\nsession: ${session()}\nstatus: open\n---\n## Đang có hiệu lực\n- Người làm: Claude — * — Viet → Claude\n`);
      assert.notEqual([1, 2, 3].map((i) => call('Bash', { command: `ssh web1 uptime ${i}` }))[2], '');
      // ssh option values are not the host.
      turn();
      fs.writeFileSync(note, `---\nsession: ${session()}\nstatus: open\n---\n## Đang có hiệu lực\n- Người làm: Claude — key — "ssh vào web1 rồi tự check"\n`);
      assert.notEqual([1, 2, 3].map((i) => call('Bash', { command: `ssh -i key -p 22 web1 uptime ${i}` }))[2], '');
      fs.rmSync(note);
    });

    await t.test('a new turn starts the count again', () => {
      turn();
      assert.equal(call('Bash', { command: 'cat repos/app/x' }), '');
    });

    await t.test('ssh is watched by its command word', () => {
      turn();
      call('Bash', { command: 'ssh host uptime' });
      call('Bash', { command: 'ssh host df -h' });
      assert.notEqual(call('Bash', { command: 'ssh host ls' }), '');
    });

    await t.test('reads outside the list, gate and CI commands do not count', () => {
      turn();
      for (let i = 0; i < 4; i++) assert.equal(call('Bash', { command: `cat "${sh(tmp)}/other-${i}"` }), '');
      assert.equal(call('Bash', { command: 'gh pr view 3 --json state' }), '');
      assert.equal(call('Bash', { command: 'git -C repos/app fetch -q origin' }), '');
      assert.equal(call('Bash', { command: `sh "${sh(tmp)}/watch.sh" 600 sh ci.sh 3` }), '');
      assert.equal(call('Bash', { command: 'orca orchestration check --run r1' }), '');
      assert.equal(call('Read', { file_path: path.join(repos, 'app', 'a') }), '');
      assert.equal(call('Read', { file_path: path.join(repos, 'app', 'b') }), '');
      assert.notEqual(call('Read', { file_path: path.join(repos, 'app', 'c') }), '');
    });

    await t.test('after worker-start in the turn, reads pass', () => {
      turn();
      call('Bash', { command: 'cat repos/app/a' });
      call('Bash', { command: 'cat repos/app/b' });
      assert.equal(call('Bash', { command: 'orca orchestration worker-start --spec-file s.md --worktree path:/x' }), '');
      assert.equal(call('Bash', { command: 'cat repos/app/c' }), '');
    });

    await t.test('commands that name no watched path do not count, even run inside one', () => {
      turn();
      const inRepo = { cwd: path.join(repos, 'app') };
      for (const c of ['date', 'echo hi', 'git commit -qm msg', 'git status --short']) assert.equal(call('Bash', { command: c }, inRepo), '');
      fs.writeFileSync(path.join(repos, 'app', 'f.sql'), 'x');
      call('Bash', { command: 'cat f.sql' }, inRepo);
      call('Grep', { pattern: 'x' }, inRepo);
      assert.notEqual(call('Bash', { command: 'cat f.sql' }, inRepo), '');
    });

    await t.test('a free command in a chain frees only itself; wrappers are seen through', () => {
      turn();
      call('Bash', { command: `gh --version; cat "${sh(repos)}/app/a"` });
      call('Bash', { command: `git -C "${sh(repos)}/app" fetch && cat "${sh(repos)}/app/b"` });
      assert.notEqual(call('Bash', { command: 'sudo ssh h3 ls' }), '');
    });

    await t.test('only a real worker-start unlocks the turn', () => {
      turn();
      call('Bash', { command: 'echo orchestration worker-start' });
      call('Bash', { command: 'orca orchestration worker-start --help' });
      call('Bash', { command: `cat "${sh(repos)}/app/a"` });
      call('Bash', { command: `cat "${sh(repos)}/app/b"` });
      assert.notEqual(call('Bash', { command: `cat "${sh(repos)}/app/c"` }), '');
    });

    await t.test('a turn Orca wakes is the gate: its reads do not count', () => {
      n++;
      guard.decide({ session_id: session(), hook_event_name: 'UserPromptSubmit', prompt: 'You have 1 orchestration message. Run `orca orchestration check --run r1`.' }, { list });
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: `git -C "${sh(repos)}/app" diff HEAD~1` }), '');
    });

    await t.test('a CI script frees only when it is the program, not an argument; git add is free', () => {
      turn();
      const inRepo = { cwd: path.join(repos, 'app') };
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'git add f.sql' }, inRepo), '');
      call('Bash', { command: `sh "${sh(tmp)}/watch.sh" 600 sh ci.sh 3` });
      call('Bash', { command: `cat "${sh(tmp)}/ci.sh" "${sh(repos)}/app/a"` });
      call('Bash', { command: `cat "${sh(repos)}/app/b"` });
      assert.notEqual(call('Bash', { command: `cat "${sh(repos)}/app/c"` }), '');
    });

    await t.test('a subagent, a worker session and no list all pass', () => {
      turn();
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'cat repos/app/a' }, { agent_id: 'sub-1' }), '');
      const wt = path.join(tmp, 'w.jsonl');
      fs.writeFileSync(wt, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Please carry out this task from my Orca coordinator.\nTask: x' } })}\n`);
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'cat repos/app/a' }, { transcript_path: wt }), '');
      assert.equal(guard.decide({ session_id: session(), cwd: tmp, tool_name: 'Bash', tool_input: { command: `cat "${sh(repos)}/app/a"` } }, { list: null }), '');
    });

    await t.test("a whole Read of the instructions file a rules hook asks for does not count", () => {
      turn();
      const repo = (name, files) => {
        const dir = path.join(repos, name);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.git'), 'gitdir: x');
        for (const f of files) fs.writeFileSync(path.join(dir, f), f);
        return dir;
      };
      const both = repo('both', ['AGENTS.md', 'CLAUDE.md', 'README.md']);
      const claudeOnly = repo('claude-only', ['CLAUDE.md', 'README.md']);
      const readmeOnly = repo('readme-only', ['README.md']);
      const linked = repo('linked', ['CLAUDE.md']);
      fs.writeFileSync(path.join(tmp, 'outside.md'), 'data');
      fs.symlinkSync(path.join(tmp, 'outside.md'), path.join(linked, 'AGENTS.md'));
      const plain = path.join(repos, 'plain');
      fs.mkdirSync(plain, { recursive: true });
      fs.writeFileSync(path.join(plain, 'AGENTS.md'), 'x');
      call('Bash', { command: `cat "${sh(repos)}/app/a"` });
      call('Bash', { command: `cat "${sh(repos)}/app/b"` });
      for (const f of [path.join(both, 'AGENTS.md'), path.join(claudeOnly, 'README.md'), 'repos/both/AGENTS.md', path.join(linked, 'AGENTS.md')]) {
        assert.equal(call('Read', { file_path: f }), '', f);
      }
      for (const [f, extra] of [
        [path.join(both, 'AGENTS.md'), { limit: 30 }],
        [path.join(both, 'AGENTS.md'), { offset: 10 }],
        [path.join(both, 'CLAUDE.md'), {}],
        [path.join(both, 'README.md'), {}],
        [path.join(claudeOnly, 'CLAUDE.md'), {}],
        [path.join(readmeOnly, 'README.md'), {}],
        [path.join(linked, 'CLAUDE.md'), {}],
        [path.join(plain, 'AGENTS.md'), {}],
        [path.join(both, 'sub', 'AGENTS.md'), {}],
      ]) assert.notEqual(call('Read', { file_path: f, ...extra }), '', `${f} ${JSON.stringify(extra)}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('shell-words: a backslash in double quotes escapes only $ ` " \\', () => {
  const { commands } = require('../claude/hooks/lib/shell-words.cjs');
  assert.deepEqual([...commands('echo "a\\b \\$x \\" \\\\"')[0]], ['echo', 'a\\b $x " \\']);
});

test('gate-line-guard: only git that runs is a git write', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-echo-'));
  execFileSync('git', ['init', '-q', tmp]);
  const linked = path.join(tmp, 'linked');
  fs.writeFileSync(path.join(tmp, 'f'), 'x');
  execFileSync('git', ['-C', tmp, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x', '--allow-empty']);
  execFileSync('git', ['-C', tmp, 'worktree', 'add', '-q', linked]);
  const writes = (command) => gateLineGuard.writesMainCheckout(command, tmp);
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
        'bash -lc \'git pull\'',
        ...['-u', '-m wip', '--keep-index', 'save wip', 'branch tmp', 'store abc'].map((a) => `git stash ${a}`),
        'git branch -f main HEAD~1',
        'git branch -Df x',
        'git update-ref refs/heads/main HEAD~1',
        'git tag -f v1',
        `git --work-tree . checkout main`,
        `cd "${L}" && git --work-tree="${T}" checkout main`,
        `cd "${L}" && GIT_WORK_TREE="${T}" git checkout main`,
        'timeout 30 git pull',
        'xargs -J % git branch -D %',
        'xargs -s 100 git branch -d',
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
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('worker-default-guard: a ~/.claude path is judged by where it leads; harness commits need the line', async (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wdg-harness-')));
  const harness = path.join(tmp, 'agent-harness');
  const other = path.join(tmp, 'other-repo');
  const claudeDir = path.join(tmp, 'home', '.claude');
  for (const r of [harness, other]) {
    fs.mkdirSync(path.join(r, 'claude', 'hooks'), { recursive: true });
    execFileSync('git', ['init', '-q', r]);
  }
  fs.writeFileSync(path.join(harness, 'claude', 'CLAUDE.md'), 'rules');
  fs.writeFileSync(path.join(harness, 'claude', 'hooks', 'h.cjs'), 'x');
  fs.mkdirSync(path.join(claudeDir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'session-notes'), { recursive: true });
  fs.symlinkSync(path.join(harness, 'claude', 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'));
  fs.symlinkSync(path.join(harness, 'claude', 'hooks', 'h.cjs'), path.join(claudeDir, 'hooks', 'h.cjs'));
  const notesDir = path.join(tmp, 'notes');
  fs.mkdirSync(path.join(notesDir, 'd'), { recursive: true });
  const transcript = path.join(tmp, 't.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'có, làm cả nhé, sửa hook đi' } })}\n`);
  const note = path.join(notesDir, 'd', 'n.md');
  const claim = (on) => fs.writeFileSync(note, `---\nsession: s1\nstatus: open\n---\n## Đang có hiệu lực\n` +
    (on ? '- Người làm: Claude — agent-harness — "có, làm cả nhé"\n' : '- nothing\n'));
  const edit = (file) => workerDefaultGuard.problem({ session_id: 's1', transcript_path: transcript, cwd: tmp, tool_name: 'Edit', tool_input: { file_path: file } }, notesDir, claudeDir);
  const bash = (command, cwd = tmp) => workerDefaultGuard.problem({ session_id: 's1', transcript_path: transcript, cwd, tool_name: 'Bash', tool_input: { command } }, notesDir, claudeDir);
  try {
    await t.test('a real file of ~/.claude passes; a symlink into the harness needs the line', () => {
      claim(false);
      assert.equal(edit(path.join(claudeDir, 'session-notes', 'x.md')), '');
      assert.match(edit(path.join(claudeDir, 'hooks', 'h.cjs')), /kaizen/);
      assert.match(edit(path.join(claudeDir, 'CLAUDE.md')), /agent-harness/);
      claim(true);
      assert.equal(edit(path.join(claudeDir, 'hooks', 'h.cjs')), '');
    });
    await t.test('git commit in the harness needs the line; elsewhere it is not judged', () => {
      claim(false);
      assert.match(bash('git commit -qm x', harness), /committing in/);
      assert.match(bash(`git -C "${harness}" commit -qm x`), /committing in/);
      assert.match(bash(`git add -A && git -C "${harness}" commit -m x`), /committing in/);
      for (const c of ['git status', 'echo git commit', `git -C "${harness}" log -1`, 'git commit --help']) assert.equal(bash(c, harness), '', c);
      assert.equal(bash('git commit -qm x', other), '');
      assert.match(bash(`cd "${harness}" && git commit -m x`), /committing in/);
      for (const c of ['git merge origin/main', 'git rebase origin/main', 'git cherry-pick abc', 'git revert HEAD']) assert.match(bash(c, harness), /committing in/, c);
      const twin = path.join(tmp, 'elsewhere', 'agent-harness');
      fs.mkdirSync(twin, { recursive: true });
      execFileSync('git', ['init', '-q', twin]);
      assert.equal(bash('git commit -qm x', twin), '', 'another repo with the same folder name');
      claim(true);
      assert.equal(bash('git commit -qm x', harness), '');
    });
    await t.test('no harness (CLAUDE.md a plain file): nothing to judge', () => {
      claim(false);
      fs.rmSync(path.join(claudeDir, 'CLAUDE.md'));
      fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'plain');
      assert.equal(bash('git commit -qm x', harness), '');
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

test('worker-start-receipt: only a dispatch the command runs is read back', () => {
  const receipt = require('../claude/hooks/worker-start-receipt.cjs');
  const ws = 'worker' + '-start';
  assert.equal(receipt.dispatches(`D=$(orca orchestration ${ws} --spec-file s.md --json)`), true);
  assert.equal(receipt.dispatches(`cd /x && orca orchestration ${ws} --spec-file s.md`), true);
  assert.equal(receipt.dispatches(`printf '%s' '{"command":"D=$(orca orchestration ${ws} --spec-file s.md)"}' | node h.cjs`), false);
  assert.equal(receipt.dispatches(`git commit -m "docs: \\\`orca orchestration ${ws}\\\`"`), false);
});

test('dispatch-split-guard: a codex or claude worker needs the user\'s pick; Gemini and a plain retry pass', () => {
  const g = dispatchSplitGuard;
  const ws = 'orca orchestration ' + 'worker' + '-start --spec-file s.md';
  const pick = (c) => g.unnamedNonGemini(c, g.workerStarts(c));
  assert.equal(pick(`${ws} --agent codex --model gpt-luna`), 'codex');
  assert.equal(pick(`${ws} --agent=claude --model sonnet`), 'claude');
  assert.equal(pick(`# Model: tác vụ phức tạp\n${ws} --agent codex --model gpt-sol`), 'codex');
  assert.equal(pick(`# Model: user chỉ định gpt-sol\n${ws} --agent codex --model gpt-sol`), '');
  assert.equal(pick(`${ws} --agent antigravity --model gemini-3.8-flash --effort high`), '');
  assert.equal(pick(`${ws} --agent codex --retry-of ctx_1`), 'codex', 'a retry that switches agent');
  assert.equal(pick('orca orchestration worker-start --retry-of ctx_1'), '');
  assert.equal(pick(`${ws} --agent  codex`), 'codex', 'two spaces');
  assert.equal(pick(`# Model: user chỉ định gpt-sol`.normalize('NFD') + `\n${ws} --agent codex`), '', 'NFD');
});

test('worker-start-receipt: a send to a running worker says the receipt is only the mailbox', () => {
  const receipt = require('../claude/hooks/worker-start-receipt.cjs');
  const states = { ctx_a1: { state: 'running' }, ctx_b2: { state: 'succeeded' }, ctx_c3: { state: 'ready' }, ctx_d4: { state: 'ready', exited: true } };
  const lines = (c) => receipt.sendLines(c, (d) => states[d]);
  assert.match(lines('orca orchestration send --to dispatch:ctx_d4 --subject x')[0], /không tới/);
  assert.match(lines('orca orchestration send --to dispatch:ctx_a1 --subject x')[0], /check --peek.*worker-stop --dispatch ctx_a1/);
  assert.doesNotMatch(lines('orca orchestration send --to dispatch:ctx_a1 --subject x')[0], /Cần bạn/);
  assert.match(lines('orca orchestration send --to=dispatch:ctx_c3 --subject x')[0], /state=ready/);
  assert.deepEqual(lines('orca orchestration send --to dispatch:ctx_b2 --subject x'), []);
  assert.deepEqual(lines('orca orchestration send --to run:run_1 --subject x'), []);
  assert.deepEqual(lines('echo "orca orchestration send --to dispatch:ctx_a1"'), []);
  assert.deepEqual(receipt.sendLines('orca orchestration send --to dispatch:ctx_zz', () => { throw new Error('x'); }), []);
});

test('coordinator-read-guard: parallel PreToolUse processes let only LIMIT reads through', async () => {
  const guardPath = path.join(HOOKS_DIR, 'coordinator-read-guard.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-par-'));
  const watchedDir = path.join(tmp, 'w');
  fs.mkdirSync(watchedDir);
  const session = `coord-par-${process.pid}-${Date.now()}`;
  const guard = require(guardPath);
  guard.decide({ session_id: session, hook_event_name: 'UserPromptSubmit' }, { list: { paths: [watchedDir], words: new Set() } });
  const start = Date.now() + 400;
  const script = `
    const g = require(${JSON.stringify(guardPath)});
    while (Date.now() < ${start}) {}
    const why = g.decide({ session_id: ${JSON.stringify(session)}, tool_use_id: 'tu_' + process.argv[1], cwd: ${JSON.stringify(tmp)},
      tool_name: 'Read', tool_input: { file_path: ${JSON.stringify(watchedDir)} + '/f' + process.argv[1] } },
      { list: { paths: [${JSON.stringify(watchedDir)}], words: new Set() } });
    process.stdout.write(why ? 'deny' : 'pass');`;
  const { spawn } = require('child_process');
  try {
    const runs = Array.from({ length: 6 }, (_, i) => new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', script, String(i)]);
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out));
    }));
    const got = await Promise.all(runs);
    assert.equal(got.filter((x) => x === 'pass').length, guard.LIMIT, got.join(','));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'claude-coordinator-reads', session), { recursive: true, force: true });
  }
});

test('secret-file-guard: a dotenv used without printing passes; printing it or a key is denied', () => {
  const guard = require('../claude/hooks/secret-file-guard.cjs');
  const E = '.e' + 'nv';
  // A stand-in for AgentKit's checkPrivacy: flags every secret-looking path it is shown.
  const checker = {
    checkPrivacy: ({ toolInput }) => {
      const text = toolInput.command || toolInput.file_path || '';
      const paths = (text.match(/[^\s"'<>]*(\.env[\w.]*|id_ed25519|\.pem)\b/g) || []).filter((p) => !/\.example$/.test(p));
      return paths.length ? { blocked: true, accesses: paths.map((filePath) => ({ filePath })) } : { blocked: false };
    },
  };
  const userTexts = () => ['cho đọc file env nhé', 'ok'];
  const run = (tool_name, x, opts = { checker, userTexts }) =>
    guard.decide({ tool_name, tool_input: tool_name === 'Bash' ? { command: x } : { file_path: x }, transcript_path: '/t' }, opts);
  for (const cmd of [
    `source ${E} && psql -c "select 1"`, `set -a; . ./${E}; set +a; node app.js`, `docker compose --env-file ${E} up -d`,
    `node --env-file=${E} x.js`, `test -f ${E} && ls -la ${E}`, `grep -q DB_URL ${E}`, `grep -c KEY ${E}`, `grep --count K ${E}`,
    `grep -L K ${E}`, `echo "A=1" >> ${E}`, `echo A=1 >${E}`, `wc -l local${E}`, `cp ${E}.example ${E}`, `ln -s ../${E} ${E}`,
    `git ls-files ${E}`, `diff -q ${E} b`, `cmp -s ${E} b`, `sha256sum ${E}`,
    `docker compose -p myproj --env-file ${E} up -d`, `git -C repo ls-files ${E}`, `source ${E} && make | tail -5`,
    `cat ${E} # secret-ok: "cho đọc file env nhé"`, 'ls -la',
  ]) assert.equal(run('Bash', cmd), '', cmd);
  for (const cmd of [
    `cat ${E}`, `cat<${E}`, `sort < ${E}`, `cat ${E}>out.txt`, `cat ${E} | wc -l`, `f=${E}; cat $f`,
    `grep DB_URL ${E}`, `grep -esecret ${E}`, `grep -- -c ${E}`, `cut -d= -f1 ${E}`, `cut -d= -f1 --complement ${E}`,
    `cp ${E} /dev/stdout`, `ln -s ${E} n.txt`, `wc --files0-from=${E}`, `set -x; source ${E}`, `bash -x -c "source ${E}"`,
    `bash -c "cat ${E}"`, `docker compose --env-file ${E} config`, `node --env-file=${E} -p process.env`,
    `docker run --env-file ${E} alpine env`, `git diff ${E}`,
    `cat <>${E}`, `cp ${E} ${E}.example`, `docker compose --env-file ${E} convert`, `uv run --env-file ${E} python -c x`,
    `cat $(ls ${E})`, `ls ${E} | xargs cat`, `set -e -x; source ${E}`, `set -v; source ${E}`, `bash -o xtrace -c "source ${E}"`,
    `grep -e -c ${E}`,
    `cat ${E} # secret-ok: "không ai nói câu này"`, `cat ${E} # secret-ok: "ok"`, 'cat k/server.pem',
  ]) assert.match(run('Bash', cmd), /secret-file-guard/, cmd);
  assert.match(run('Read', E), /secret-file-guard/);
  assert.match(run('Edit', E), /secret-file-guard/);
  assert.equal(run('Write', E), '');
  assert.equal(run('Read', 'src/app.js'), '');
  // No checker, or one that throws: fail closed, even a quiet use is denied, and the reason says why.
  for (const broken of [null, { checkPrivacy: () => { throw new Error('moved'); } }]) {
    assert.match(run('Bash', `source ${E}`, { checker: broken, userTexts }), /did not load or failed/);
    assert.equal(run('Bash', `cat ${E} # secret-ok: "cho đọc file env nhé"`, { checker: broken, userTexts }), '');
    assert.equal(run('Bash', 'ls -la', { checker: broken, userTexts }), '');
  }
  // A command the checker cannot read stays denied, with its reason.
  const opaque = { checkPrivacy: () => ({ blocked: true, uninspectable: true, accesses: [], reason: 'eval of a variable' }) };
  assert.match(run('Bash', 'eval "$X"', { checker: opaque, userTexts }), /eval of a variable/);
});

test('worker-default-guard: userTexts skips entries no human typed (task notifications, other sessions)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'user-texts-'));
  const t = path.join(tmp, 't.jsonl');
  const line = (content, origin) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...(origin ? { origin } : {}) });
  try {
    fs.writeFileSync(t, [line('câu của Viet'), line('gõ tay', { kind: 'human' }), line('Agent finished: chạy xong', { kind: 'task-notification' })].join('\n'));
    assert.deepEqual(workerDefaultGuard.userTexts(t), ['câu của Viet', 'gõ tay']);
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

test('gate-line-guard: a Gate line in an earlier Bash call of the turn counts, not one before the prompt', () => {
  const j = (r) => JSON.stringify(r);
  const prompt = (text) => j({ type: 'user', message: { content: text } });
  const bash = (command) => j({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const result = j({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
  const reminder = j({ type: 'attachment', attachment: { type: 'silent_turn_reminder' } });
  const gated = bash('# Gate: mở bởi "làm đi" → khối X\ngit worktree add ../wt');
  assert.equal(gateLineGuard.gatePrinted([prompt('làm đi'), gated, result, reminder, bash('ls'), result]), true);
  assert.equal(gateLineGuard.gatePrinted([prompt('làm đi'), gated, result, prompt('merge đi'), bash('ls'), result]), false,
    'a new prompt opens a new turn');
  assert.equal(gateLineGuard.gatePrinted([prompt('làm đi'), bash('echo Gate'), result]), false);
  for (const read of ['# Gate: không áp (chỉ đọc)\ngit status', 'grep -rn "Gate:" ~/.claude/CLAUDE.md'])
    assert.equal(gateLineGuard.gatePrinted([prompt('làm đi'), bash(read), result]), false, read);
});

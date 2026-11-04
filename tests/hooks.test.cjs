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

    await t.test('a new spec that never asks for a mid-turn inbox check is blocked', () => {
      const ws = 'worker' + '-start';
      const spec = (name, body) => { fs.writeFileSync(path.join(tmp, name), body); return name; };
      const flags = '--agent antigravity --model gemini-3.8-flash --effort high';
      const cmd = (rest) => `# Track: w9 ← rà [a.py]\ncd "${tmp}" && orca orchestration ${ws} ${rest} ${flags}`;
      const yes = spec('yes.md', 'Rà a.py. Chạy `orca orchestration check --peek` trước mỗi commit.');
      const no = spec('no.md', 'Rà a.py, báo lại.');
      const neg = spec('neg.md', 'Rà a.py. Đừng chạy `orca orchestration check --peek`.');
      const block = (c, why) => { const r = run(c); assert.equal(r.status, 2, why); assert.match(r.stderr, /check --peek/, why); };
      const pass = (c, why) => { const r = run(c); assert.equal(r.status, 0, `${why}: ${r.stderr}`); };
      block(cmd(`--spec-file ${no}`), 'spec without it');
      block(cmd(`--spec-file ${neg}`), 'a negated mention');
      block(`# nhắc: check --peek\n${cmd(`--spec-file ${no}`)}`, 'a comment in the command is not the spec');
      block(`orca orchestration check --peek; ${cmd(`--spec-file ${no}`)}`, 'the coordinator checking is not the spec');
      block(`${cmd(`--spec-file ${yes}`)}; orca orchestration ${ws} --spec-file ${no} ${flags}`, 'each dispatch is judged');
      block(`orca orchestration task-create --spec 'Rà a.py'`, 'task-create brings a spec too');
      pass(cmd(`--spec-file ${yes}`), 'spec with it');
      pass(cmd(`--spec "Rà a.py; chạy orca orchestration check --unread --peek sau mỗi 10 lệnh"`), 'inline, other flags between');
      pass(cmd('--task task_1 --retry-of ctx_1'), 'a --task retry runs a Task already judged');
      pass(cmd('--spec-file "$F"'), 'a spec path in a variable is not judged');
      pass(cmd('--spec-file missing.md'), 'an unreadable spec is not judged');
      pass(`orca orchestration ${ws} --help`, 'help');
    });

    await t.test('the words of a dispatch inside a quoted string are not a dispatch', () => {
      const ws = 'worker' + '-start';
      for (const c of [`CMD='cd /x && orca orchestration ${ws} --spec-file a.md'; echo "$CMD"`,
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

test('worker-start-receipt: a send to a running worker reminds that the message is queued', () => {
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

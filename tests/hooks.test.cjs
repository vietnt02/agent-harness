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

    // Case B: worker-default-guard with file inside .claude (exempt)
    await t.test('worker-default-guard POSIX payload behavior', () => {
      const claudeFile = path.join(os.homedir(), '.claude', 'CLAUDE.md');
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
      const res = run('orca orchestration task-create --spec "lark-cli base +record-batch-update --dry-run --json @a.json"');
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
  const call = (tool_name, tool_input, extra = {}) =>
    guard.decide({ session_id: session(), transcript_path: transcript, cwd: path.join(tmp, 'umb'), tool_name, tool_input, ...extra }, { list, notesDir });
  const turn = () => { n++; guard.decide({ session_id: session(), hook_event_name: 'UserPromptSubmit' }, { list }); };

  try {
    await t.test('two reads pass, the third is denied', () => {
      turn();
      assert.equal(call('Bash', { command: 'git -C repos/app grep -n foo' }), '');
      assert.equal(call('Read', { file_path: path.join(repos, 'app', 'a.sql') }), '');
      assert.match(call('Grep', { pattern: 'x', path: 'repos/app' }), /read 3 of a watched place/);
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
      for (let i = 0; i < 4; i++) assert.equal(call('Bash', { command: `cat ${sh(tmp)}/other-${i}` }), '');
      assert.equal(call('Bash', { command: 'gh pr view 3 --json state' }), '');
      assert.equal(call('Bash', { command: 'git -C repos/app fetch -q origin' }), '');
      assert.equal(call('Bash', { command: `sh ${sh(tmp)}/watch.sh 600 sh ci.sh 3` }), '');
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
      call('Bash', { command: `gh --version; cat ${sh(repos)}/app/a` });
      call('Bash', { command: `git -C ${sh(repos)}/app fetch && cat ${sh(repos)}/app/b` });
      assert.notEqual(call('Bash', { command: 'sudo ssh h3 ls' }), '');
    });

    await t.test('only a real worker-start unlocks the turn', () => {
      turn();
      call('Bash', { command: 'echo orchestration worker-start' });
      call('Bash', { command: 'orca orchestration worker-start --help' });
      call('Bash', { command: `cat ${sh(repos)}/app/a` });
      call('Bash', { command: `cat ${sh(repos)}/app/b` });
      assert.notEqual(call('Bash', { command: `cat ${sh(repos)}/app/c` }), '');
    });

    await t.test('a turn Orca wakes is the gate: its reads do not count', () => {
      n++;
      guard.decide({ session_id: session(), hook_event_name: 'UserPromptSubmit', prompt: 'You have 1 orchestration message. Run `orca orchestration check --run r1`.' }, { list });
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: `git -C ${sh(repos)}/app diff HEAD~1` }), '');
    });

    await t.test('a CI script frees only when it is the program, not an argument; git add is free', () => {
      turn();
      const inRepo = { cwd: path.join(repos, 'app') };
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'git add f.sql' }, inRepo), '');
      call('Bash', { command: `sh ${sh(tmp)}/watch.sh 600 sh ci.sh 3` });
      call('Bash', { command: `cat ${sh(tmp)}/ci.sh ${sh(repos)}/app/a` });
      call('Bash', { command: `cat ${sh(repos)}/app/b` });
      assert.notEqual(call('Bash', { command: `cat ${sh(repos)}/app/c` }), '');
    });

    await t.test('a subagent, a worker session and no list all pass', () => {
      turn();
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'cat repos/app/a' }, { agent_id: 'sub-1' }), '');
      const wt = path.join(tmp, 'w.jsonl');
      fs.writeFileSync(wt, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Please carry out this task from my Orca coordinator.\nTask: x' } })}\n`);
      for (let i = 0; i < 3; i++) assert.equal(call('Bash', { command: 'cat repos/app/a' }, { transcript_path: wt }), '');
      assert.equal(guard.decide({ session_id: session(), cwd: tmp, tool_name: 'Bash', tool_input: { command: `cat ${sh(repos)}/app/a` } }, { list: null }), '');
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
      call('Bash', { command: `cat ${sh(repos)}/app/a` });
      call('Bash', { command: `cat ${sh(repos)}/app/b` });
      for (const f of [path.join(both, 'AGENTS.md'), path.join(claudeOnly, 'README.md'), 'repos/both/AGENTS.md']) {
        assert.equal(call('Read', { file_path: f }), '', f);
      }
      for (const [f, extra] of [
        [path.join(both, 'AGENTS.md'), { limit: 30 }],
        [path.join(both, 'AGENTS.md'), { offset: 10 }],
        [path.join(both, 'CLAUDE.md'), {}],
        [path.join(both, 'README.md'), {}],
        [path.join(claudeOnly, 'CLAUDE.md'), {}],
        [path.join(readmeOnly, 'README.md'), {}],
        [path.join(linked, 'AGENTS.md'), {}],
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
        `cd ${linked} && git checkout -q HEAD`,
        `git -C ${linked} reset --hard`,
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
        `cd ${linked} && cd .. && git stash`,
        `git -C ${linked} -C .. branch -D x`,
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
        `cd ${linked} && git --work-tree=${tmp} checkout main`,
        `cd ${linked} && GIT_WORK_TREE=${tmp} git checkout main`,
        'timeout 30 git pull',
        'xargs -J % git branch -D %',
        'xargs -s 100 git branch -d',
        `cd ${linked} && env -C ${tmp} git checkout main`,
        `(cd ${linked} && git status); git checkout main`,
        `x=$(cd ${linked}; pwd); git checkout main`,
        `cd ${linked} && pushd ${tmp} && git checkout main`,
        `cd ${linked} && cd -- ${tmp} && git checkout main`,
        `cd ${linked} && cd -P ${tmp} && git checkout main`,
        `cd ${linked} && M=${tmp}; cd $M && git checkout main`,
        `cd ${linked} && cd - && git checkout main`,
        `cd ${linked} && cd ${linked}/not-made-yet && git checkout main`,
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
        `(cd ${linked} && git checkout -q HEAD)`,
        `cd ${linked} && x=$(cd ${tmp}; pwd) && git checkout -q HEAD`,
        `cd ${linked} && bash -c "git checkout -q HEAD"`,
        'ssh host "git checkout main"',
        `cd -- ${linked} && git checkout -q HEAD`,
        'git stash list',
        'git branch -a',
        'git tag -l',
      ]) assert.equal(writes(c), false, c);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

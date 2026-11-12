const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child_process = require('node:child_process');

const repoDir = path.resolve(__dirname, '..');
const installScript = path.join(repoDir, 'install.cjs');

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-home-'));
}

function cleanupTempHome(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function runInstall(home, extraArgs = []) {
  return child_process.spawnSync(process.execPath, [installScript, '--home', home, ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function getAllSymlinks(dir) {
  const symlinks = [];
  function walk(current) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        symlinks.push(full);
      } else if (st.isDirectory()) {
        walk(full);
      }
    }
  }
  walk(dir);
  return symlinks;
}

function getExpectedSymlinkCount() {
  let count = 0;
  function walkDir(dir, filter) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!filter || filter(full, true)) walkDir(full, filter);
      } else if (ent.isFile()) {
        if (!filter || filter(full, false)) count++;
      }
    }
  }

  // claude files (excluding skills and .DS_Store)
  walkDir(path.join(repoDir, 'claude'), (p, isDir) => {
    const rel = path.relative(path.join(repoDir, 'claude'), p);
    if (rel.split(path.sep)[0] === 'skills') return false;
    if (!isDir && path.basename(p) === '.DS_Store') return false;
    return true;
  });

  // claude skills dirs
  const skillsDir = path.join(repoDir, 'claude', 'skills');
  if (fs.existsSync(skillsDir)) {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) count++;
    }
  }

  // agy files (excluding .DS_Store, local.json, tested-versions.json)
  walkDir(path.join(repoDir, 'agy'), (p, isDir) => {
    if (!isDir) {
      const base = path.basename(p);
      if (base === '.DS_Store' || base === 'local.json' || base === 'tested-versions.json') return false;
    }
    return true;
  });

  return count;
}

function countHooksInSettings(settings) {
  let count = 0;
  for (const event of Object.keys(settings.hooks || {})) {
    for (const group of settings.hooks[event] || []) {
      for (const _h of group.hooks || []) {
        count++;
      }
    }
  }
  return count;
}

test('1. clean home: symlinks, repo resolution, 19 hooks format, templates, no backup', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const res = runInstall(home);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);

  // Symlink count check
  const symlinks = getAllSymlinks(home);
  const expectedCount = getExpectedSymlinkCount();
  assert.strictEqual(symlinks.length, expectedCount, `Expected ${expectedCount} symlinks, got ${symlinks.length}`);

  // All symlinks resolve to files in repo
  const canonicalRepo = fs.realpathSync(repoDir).toLowerCase();
  for (const symlink of symlinks) {
    let dest = fs.readlinkSync(symlink);
    if (dest.startsWith('\\\\?\\') || dest.startsWith('\\??\\')) {
      dest = dest.slice(4);
    }
    const resolved = path.resolve(path.dirname(symlink), dest);
    assert.ok(fs.existsSync(resolved), `Symlink target does not exist: ${symlink} -> ${dest}`);
    const canonicalTarget = fs.realpathSync(symlink).toLowerCase();
    assert.ok(
      canonicalTarget.startsWith(canonicalRepo),
      `Symlink target not in repo: ${symlink} -> ${canonicalTarget} (repo: ${canonicalRepo})`
    );
  }

  // Settings has exactly 19 hooks in correct OS format
  const settingsPath = path.join(home, '.claude', 'settings.json');
  assert.ok(fs.existsSync(settingsPath), 'settings.json does not exist');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  let hookCount = 0;
  for (const event of Object.keys(settings.hooks || {})) {
    for (const group of settings.hooks[event] || []) {
      for (const h of group.hooks || []) {
        hookCount++;
        assert.strictEqual(h.type, 'command');
        assert.strictEqual(typeof h.command, 'string');
        if (process.platform === 'win32') {
          assert.ok(Array.isArray(h.args), `Hook should have args on win32: ${JSON.stringify(h)}`);
          assert.ok(!h.command.includes('\\'), `Command path must use / on win32: ${h.command}`);
          for (const arg of h.args) {
            assert.ok(!arg.includes('\\'), `Arg path must use / on win32: ${arg}`);
          }
        } else {
          assert.strictEqual(h.args, undefined, `Hook should not have args on non-win32: ${JSON.stringify(h)}`);
        }
      }
    }
  }
  assert.strictEqual(hookCount, 19, `Expected 19 hooks, found ${hookCount}`);

  // 3 templates copied
  const templates = ['identities.md', 'knowledge-index.md', 'user-profile.md'];
  for (const tmpl of templates) {
    const tmplPath = path.join(home, '.claude', 'rules', 'mine', tmpl);
    assert.ok(fs.existsSync(tmplPath), `Template missing: ${tmplPath}`);
    const st = fs.lstatSync(tmplPath);
    assert.ok(!st.isSymbolicLink(), `Template should be a real copy, not symlink: ${tmplPath}`);
    assert.ok(st.isFile());
    const originalContent = fs.readFileSync(path.join(repoDir, 'templates', 'rules-mine', tmpl), 'utf8');
    const installedContent = fs.readFileSync(tmplPath, 'utf8');
    assert.strictEqual(installedContent, originalContent);
  }

  // No backup directory
  const backupDir = path.join(home, '.claude', 'backups');
  assert.ok(!fs.existsSync(backupDir), 'Backup directory should not exist on fresh install');
});

test('2. second run: settings and hooks.json byte identical, no new backup, no new symlink', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const firstRes = runInstall(home);
  assert.strictEqual(firstRes.status, 0, `first install failed: ${firstRes.stderr}`);

  const settingsPath = path.join(home, '.claude', 'settings.json');
  const hooksPath = path.join(home, '.gemini', 'config', 'hooks.json');
  const settingsBefore = fs.readFileSync(settingsPath);
  const hooksBefore = fs.readFileSync(hooksPath);
  const symlinksBefore = getAllSymlinks(home);

  const secondRes = runInstall(home);
  assert.strictEqual(secondRes.status, 0, `second install failed: ${secondRes.stderr}`);

  const settingsAfter = fs.readFileSync(settingsPath);
  const hooksAfter = fs.readFileSync(hooksPath);
  const symlinksAfter = getAllSymlinks(home);

  assert.deepStrictEqual(settingsAfter, settingsBefore, 'settings.json changed on second run');
  assert.deepStrictEqual(hooksAfter, hooksBefore, 'hooks.json changed on second run');
  assert.strictEqual(symlinksAfter.length, symlinksBefore.length, 'Symlink count changed on second run');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'backups')), 'Backup directory created on second run');
});

test('2b. a link to a file the repo moved is removed; the moved file is linked; a link elsewhere is kept', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));
  // The shape a move leaves behind: claude/rules/mine/x.md moved to claude/rules/agent-harness/x.md,
  // so ~/.claude/rules/mine/x.md still points at the old repo path.
  const moved = path.join(home, '.claude', 'rules', 'mine', 'communication-style.md');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.symlinkSync(path.join(repoDir, 'claude', 'rules', 'mine', 'communication-style.md'), moved, 'file');
  const own = path.join(home, '.claude', 'hooks', 'my-hook.cjs');
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.symlinkSync(path.join(home, 'elsewhere', 'gone.cjs'), own, 'file');
  const mine = path.join(home, '.claude', 'rules', 'mine', 'identities.md');
  fs.writeFileSync(mine, 'mine');

  // A dead link inside a directory the user linked in is not walked into.
  const linkedDir = path.join(home, 'my-skill');
  fs.mkdirSync(linkedDir);
  fs.symlinkSync(path.join(repoDir, 'claude', 'skills', 'gone', 'SKILL.md'), path.join(linkedDir, 'SKILL.md'), 'file');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(linkedDir, path.join(home, '.claude', 'skills', 'my-skill'), 'dir');

  const dry = runInstall(home, ['--dry-run']);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.ok(fs.lstatSync(moved).isSymbolicLink(), 'a dry run removes nothing');
  const res = runInstall(home);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.throws(() => fs.lstatSync(moved), /ENOENT/, 'the dead link into the repo is gone');
  assert.ok(fs.lstatSync(path.join(linkedDir, 'SKILL.md')).isSymbolicLink(), 'a linked directory is not walked into');
  assert.ok(fs.lstatSync(own).isSymbolicLink(), 'a link pointing outside the repo is the user\'s');
  assert.strictEqual(fs.readFileSync(mine, 'utf8'), 'mine', 'a personal rule file is untouched');
  const now = path.join(home, '.claude', 'rules', 'agent-harness', 'communication-style.md');
  assert.strictEqual(fs.realpathSync(now), fs.realpathSync(path.join(repoDir, 'claude', 'rules', 'agent-harness', 'communication-style.md')));
});

test('3. dry-run on empty home does not create any files', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const res = runInstall(home, ['--dry-run']);
  assert.strictEqual(res.status, 0, `dry-run failed: ${res.stderr}`);

  const files = fs.readdirSync(home);
  assert.strictEqual(files.length, 0, `dry-run created files: ${files.join(', ')}`);
});

test('4. existing normal CLAUDE.md and custom hook: CLAUDE.md backed up, custom hook kept, 19 hooks added', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const claudeMdPath = path.join(claudeDir, 'CLAUDE.md');
  const customClaudeContent = '# Custom User Rules\n';
  fs.writeFileSync(claudeMdPath, customClaudeContent, 'utf8');

  const customHookCmd = 'echo custom-hook-strange-unique';
  const customSettings = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: customHookCmd,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(customSettings, null, 2) + '\n', 'utf8');

  const res = runInstall(home);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);

  // CLAUDE.md is now a symlink
  assert.ok(fs.lstatSync(claudeMdPath).isSymbolicLink(), 'CLAUDE.md should be replaced with a symlink');

  // Old CLAUDE.md and old settings.json are in backup
  const backupsDir = path.join(claudeDir, 'backups');
  assert.ok(fs.existsSync(backupsDir), 'Backup directory should exist');
  const backupEntries = fs.readdirSync(backupsDir).filter((d) => d.startsWith('harness-install-'));
  assert.ok(backupEntries.length >= 1, 'At least one backup folder should exist');
  const backupFolder = path.join(backupsDir, backupEntries[0]);

  const backedUpClaudeMd = path.join(backupFolder, '.claude', 'CLAUDE.md');
  assert.ok(fs.existsSync(backedUpClaudeMd), `Backed up CLAUDE.md missing: ${backedUpClaudeMd}`);
  assert.strictEqual(fs.readFileSync(backedUpClaudeMd, 'utf8'), customClaudeContent);

  const backedUpSettings = path.join(backupFolder, '.claude', 'settings.json');
  assert.ok(fs.existsSync(backedUpSettings), `Backed up settings.json missing: ${backedUpSettings}`);

  // In new settings: custom hook kept, 19 hooks added -> total 20 hooks
  const newSettings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  let foundCustomHook = false;
  for (const group of newSettings.hooks.PostToolUse || []) {
    for (const h of group.hooks || []) {
      if (h.command === customHookCmd) {
        foundCustomHook = true;
      }
    }
  }
  assert.ok(foundCustomHook, 'Custom hook was removed');
  assert.strictEqual(countHooksInSettings(newSettings), 20, 'Expected 20 total hooks (1 custom + 19 added)');
});

test('5. settings already has 19 hooks in shell form: merge adds 0 hooks on any OS', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  // Read shared claude settings and replace placeholders
  const rawShared = fs.readFileSync(path.join(repoDir, 'settings', 'claude-settings.shared.json'), 'utf8');
  const normHome = process.platform === 'win32' ? home.replace(/\\/g, '/') : home;
  const normNode = process.platform === 'win32' ? process.execPath.replace(/\\/g, '/') : process.execPath;
  const shellFormContent = rawShared.split('{HOME}').join(normHome).split('{NODE}').join(normNode);

  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, shellFormContent, 'utf8');

  const res = runInstall(home);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);

  const updatedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(countHooksInSettings(updatedSettings), 19, 'Should still have exactly 19 hooks');
  assert.ok(!fs.existsSync(path.join(claudeDir, 'backups')), 'No backup should be created when 0 hooks added');
});

test('5b. a harness hook installed under an older matcher takes the shared matcher', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const rawShared = fs.readFileSync(path.join(repoDir, 'settings', 'claude-settings.shared.json'), 'utf8');
  const normHome = process.platform === 'win32' ? home.replace(/\\/g, '/') : home;
  const normNode = process.platform === 'win32' ? process.execPath.replace(/\\/g, '/') : process.execPath;
  const old = JSON.parse(rawShared.split('{HOME}').join(normHome).split('{NODE}').join(normNode));
  const isGuard = (g) => g.hooks.some((h) => /secret-file-guard\.cjs/.test(h.command));
  const shared = old.hooks.PreToolUse.find(isGuard).matcher;
  old.hooks.PreToolUse.find(isGuard).matcher = 'Write|Edit|MultiEdit|NotebookEdit';
  old.hooks.PreToolUse.push({ matcher: 'Read', hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: `"${normNode}" "${normHome}/.claude/hooks/x-user.cjs"` }] });
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(old, null, 2), 'utf8');

  const res = runInstall(home);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);
  const updated = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.strictEqual(updated.hooks.PreToolUse.find(isGuard).matcher, shared);
  assert.ok(shared.includes('Bash'));
  assert.strictEqual(updated.hooks.PreToolUse.filter(isGuard).length, 1, 'no second group for the same hook');
  assert.strictEqual(updated.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command === 'echo mine')).matcher, 'Read');
});

test('5c. a hook pointing at a harness script the repo dropped is removed; a user hook is kept', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const normHome = process.platform === 'win32' ? home.replace(/\\/g, '/') : home;
  const normNode = process.platform === 'win32' ? process.execPath.replace(/\\/g, '/') : process.execPath;
  const dropped = `"${normNode}" "${normHome}/.claude/hooks/retired-guard.cjs"`;
  const mine = `"${normNode}" "${normHome}/my-hooks/mine.cjs"`;
  const settingsPath = path.join(claudeDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: dropped }] },
    { matcher: 'Read', hooks: [{ type: 'command', command: mine }, { type: 'command', command: dropped }] },
  ] } }, null, 2), 'utf8');

  const res = runInstall(home);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);
  const commands = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => [h.command, ...(h.args || [])].join(' ')));
  assert.ok(!commands.some((c) => c.includes('retired-guard.cjs')), 'the dead harness hook is gone');
  assert.ok(commands.some((c) => c.includes('my-hooks/mine.cjs')), 'a hook outside ~/.claude/hooks is the user\'s');
});

test('6. existing .gemini/config/hooks.json with orca-status: claude-bridge added, orca-status preserved', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const agyDir = path.join(home, '.gemini', 'config');
  fs.mkdirSync(agyDir, { recursive: true });
  const agyHooksPath = path.join(agyDir, 'hooks.json');
  const originalOrcaStatus = { enabled: true, frequency: 'high', meta: { id: 123 } };
  fs.writeFileSync(agyHooksPath, JSON.stringify({ 'orca-status': originalOrcaStatus }, null, 2) + '\n', 'utf8');

  const res = runInstall(home);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);

  const updatedAgyHooks = JSON.parse(fs.readFileSync(agyHooksPath, 'utf8'));
  assert.deepStrictEqual(updatedAgyHooks['orca-status'], originalOrcaStatus, 'orca-status modified');
  assert.ok(updatedAgyHooks['claude-bridge'], 'claude-bridge not added');
});

test('7. run each hook in installed settings: Claude Code invocation, exit 0 or 2, no Error stack', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const installRes = runInstall(home);
  assert.strictEqual(installRes.status, 0, `install failed: ${installRes.stderr}`);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  let testedHooks = 0;

  for (const event of Object.keys(settings.hooks || {})) {
    for (const group of settings.hooks[event] || []) {
      for (const h of group.hooks || []) {
        testedHooks++;
        let res;
        if (Array.isArray(h.args)) {
          res = child_process.spawnSync(h.command, h.args, {
            input: '{}',
            encoding: 'utf8',
            env: { ...process.env, HOME: home, USERPROFILE: home },
          });
        } else {
          res = child_process.spawnSync('sh', ['-c', h.command], {
            input: '{}',
            encoding: 'utf8',
            env: { ...process.env, HOME: home, USERPROFILE: home },
          });
        }

        assert.ok(
          res.status === 0 || res.status === 2,
          `Hook failed with exit code ${res.status}: ${JSON.stringify(h)}\nstderr: ${res.stderr}\nstdout: ${res.stdout}`
        );

        const hasStackError = /Error:[\s\S]*?\s+at\s+/.test(res.stderr || '');
        assert.strictEqual(
          hasStackError,
          false,
          `Hook threw unhandled exception with stack trace: ${JSON.stringify(h)}\nstderr: ${res.stderr}`
        );
      }
    }
  }

  assert.strictEqual(testedHooks, 19, `Expected to test 19 hooks, tested ${testedHooks}`);
});

test('8. install --node <path> uses specified node binary', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const customNode = path.join(os.tmpdir(), 'custom-node-bin');
  const res = runInstall(home, ['--node', customNode]);
  assert.strictEqual(res.status, 0, `install failed: ${res.stderr}`);

  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const sampleHook = settings.hooks.PostToolUse[0].hooks[0];
  if (process.platform === 'win32') {
    assert.strictEqual(sampleHook.command, customNode.replace(/\\/g, '/'));
  } else {
    assert.ok(sampleHook.command.includes(`"${customNode}"`));
  }
});

test('9. install --node without argument fails with exit 1 and error message', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  const res = runInstall(home, ['--node']);
  assert.strictEqual(res.status, 1, 'Expected exit code 1');
  assert.ok(
    res.stderr.includes('Lỗi: --node cần một tham số đường dẫn.'),
    `Expected error message in stderr, got: ${res.stderr}`
  );
});

test('10. HARNESS_PLATFORM=win32 generates quoted node and script paths in hooks.json', (t) => {
  const home = makeTempHome();
  t.after(() => cleanupTempHome(home));

  fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });

  const customWinNode = 'C:\\Program Files\\nodejs\\node.exe';
  const res = child_process.spawnSync(
    process.execPath,
    [
      path.join(repoDir, 'tools', 'merge-hooks.cjs'),
      '--home', home,
      '--node', customWinNode,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_PLATFORM: 'win32' },
    }
  );
  assert.strictEqual(res.status, 0, `merge-hooks failed: ${res.stderr}\n${res.stdout}`);

  const agyHooksPath = path.join(home, '.gemini', 'config', 'hooks.json');
  assert.ok(fs.existsSync(agyHooksPath), 'hooks.json does not exist');
  const agyHooks = JSON.parse(fs.readFileSync(agyHooksPath, 'utf8'));
  const bridge = agyHooks['claude-bridge'];
  assert.ok(bridge, 'claude-bridge missing in hooks.json');

  function checkCmd(cmd) {
    assert.match(
      cmd,
      /^"[^"]+" "[^"]+"\s+\w+$/,
      `Command should have quoted node and script paths on win32: ${cmd}`
    );
    assert.ok(!cmd.includes('\\'), `Command should use forward slashes: ${cmd}`);
    assert.ok(cmd.startsWith('"C:/Program Files/nodejs/node.exe"'), `Command should start with quoted node: ${cmd}`);
  }

  for (const item of bridge.PreInvocation || []) {
    checkCmd(item.command);
  }
  for (const group of bridge.PreToolUse || []) {
    for (const h of group.hooks || []) {
      checkCmd(h.command);
    }
  }
  for (const group of bridge.PostToolUse || []) {
    for (const h of group.hooks || []) {
      checkCmd(h.command);
    }
  }
  for (const item of bridge.Stop || []) {
    checkCmd(item.command);
  }
});


test('.gitattributes keeps checkouts LF when core.autocrlf=true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-eol-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args) => {
      const res = child_process.spawnSync('git', ['-c', 'core.autocrlf=true', ...args], { cwd: dir, encoding: 'utf8', env });
      assert.strictEqual(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
    };
    git('init', '-q');
    fs.copyFileSync(path.join(repoDir, '.gitattributes'), path.join(dir, '.gitattributes'));
    const file = path.join(dir, 'rule.md');
    const text = 'line one\nline two\n';
    fs.writeFileSync(file, text);
    git('add', '-A');
    fs.rmSync(file);
    git('checkout-index', '-f', '--all');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

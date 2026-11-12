#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');

function splitShellTokens(cmd) {
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = regex.exec(cmd)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    } else if (match[2] !== undefined) {
      tokens.push(match[2]);
    } else if (match[3] !== undefined) {
      tokens.push(match[3]);
    }
  }
  return tokens;
}

function getHookKey(h, isWin) {
  if (!h || typeof h !== 'object') return null;
  let tokens = [];
  if (Array.isArray(h.args)) {
    tokens = [h.command, ...h.args];
  } else if (typeof h.command === 'string') {
    tokens = splitShellTokens(h.command);
  } else {
    return null;
  }

  const cjsIndex = tokens.findIndex(t => typeof t === 'string' && /\.cjs$/i.test(t.replace(/^["']|["']$/g, '')));
  if (cjsIndex !== -1) {
    let scriptPath = tokens[cjsIndex].replace(/^["']|["']$/g, '').replace(/\\/g, '/');
    let restArgs = tokens.slice(cjsIndex + 1).map(a => String(a).replace(/^["']|["']$/g, '').replace(/\\/g, '/'));
    if (isWin) {
      scriptPath = scriptPath.toLowerCase();
      restArgs = restArgs.map(a => a.toLowerCase());
    }
    return `cjs:${scriptPath}${restArgs.length ? ' ' + restArgs.join(' ') : ''}`;
  }

  let cmdStr = typeof h.command === 'string' ? h.command : '';
  if (Array.isArray(h.args)) {
    cmdStr += ' ' + h.args.join(' ');
  }
  cmdStr = cmdStr.replace(/\\/g, '/');
  if (isWin) {
    cmdStr = cmdStr.toLowerCase();
  }
  return `raw:${cmdStr.trim()}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let homeDir = '';
  let nodePath = process.execPath;
  let dryRun = false;
  let backupDir = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--home') {
      if (i + 1 >= args.length) {
        console.error('Lỗi: --home cần một tham số đường dẫn.');
        process.exit(1);
      }
      homeDir = args[++i];
    } else if (arg.startsWith('--home=')) {
      homeDir = arg.slice(7);
    } else if (arg === '--node') {
      if (i + 1 >= args.length) {
        console.error('Lỗi: --node cần một tham số đường dẫn.');
        process.exit(1);
      }
      nodePath = args[++i];
    } else if (arg.startsWith('--node=')) {
      nodePath = arg.slice(7);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--backup-dir') {
      if (i + 1 >= args.length) {
        console.error('Lỗi: --backup-dir cần một tham số đường dẫn.');
        process.exit(1);
      }
      backupDir = args[++i];
    } else if (arg.startsWith('--backup-dir=')) {
      backupDir = arg.slice(13);
    } else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node merge-hooks.cjs [--home <dir>] [--node <path>] [--dry-run] [--backup-dir <dir>]');
      process.exit(0);
    }
  }

  if (!homeDir) {
    homeDir = os.homedir();
  }

  if (!homeDir) {
    console.error('Lỗi: Cần chỉ định --home hoặc biến môi trường HOME.');
    process.exit(1);
  }

  if (!/^[a-zA-Z]:[\\/]/.test(homeDir)) {
    homeDir = path.resolve(homeDir);
  }
  if (!/^[a-zA-Z]:[\\/]/.test(nodePath)) {
    nodePath = path.resolve(nodePath);
  }

  if (!backupDir) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    backupDir = path.join(homeDir, '.claude', 'backups', `harness-install-${ts}`);
  } else {
    backupDir = path.resolve(backupDir);
  }

  return { homeDir, nodePath, dryRun, backupDir };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function replacePlaceholders(content, homeDir, nodePath, isWin) {
  const normHome = isWin ? homeDir.replace(/\\/g, '/') : homeDir;
  const normNode = isWin ? nodePath.replace(/\\/g, '/') : nodePath;
  return content.split('{HOME}').join(normHome).split('{NODE}').join(normNode);
}

function replaceAgyPlaceholders(content, homeDir, nodePath, isWin) {
  const normHome = isWin ? homeDir.replace(/\\/g, '/') : homeDir;
  const normNode = isWin ? nodePath.replace(/\\/g, '/') : nodePath;
  if (isWin) {
    return content.replace(/\{NODE\}\s+(\{HOME\}[^\s\\"]+)/g, (_m, script) => {
      const resolvedScript = script.split('{HOME}').join(normHome);
      return `\\"${normNode}\\" \\"${resolvedScript}\\"`;
    });
  }
  return content.split('{HOME}').join(normHome).split('{NODE}').join(normNode);
}

function main() {
  const { homeDir, nodePath, dryRun, backupDir } = parseArgs();
  const repoDir = path.resolve(__dirname, '..');
  const isWin = (process.env.HARNESS_PLATFORM || process.platform) === 'win32';

  const claudeSharedPath = path.join(repoDir, 'settings', 'claude-settings.shared.json');
  const agySharedPath = path.join(repoDir, 'settings', 'agy-hooks.shared.json');

  if (!fs.existsSync(claudeSharedPath)) {
    console.error(`Lỗi: Không tìm thấy file shared: ${claudeSharedPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(agySharedPath)) {
    console.error(`Lỗi: Không tìm thấy file shared: ${agySharedPath}`);
    process.exit(1);
  }

  const rawClaudeShared = fs.readFileSync(claudeSharedPath, 'utf8');
  const rawAgyShared = fs.readFileSync(agySharedPath, 'utf8');

  const replacedClaudeShared = replacePlaceholders(rawClaudeShared, homeDir, nodePath, isWin);
  const replacedAgyShared = replaceAgyPlaceholders(rawAgyShared, homeDir, nodePath, isWin);

  let sharedClaudeObj;
  let sharedAgyObj;
  try {
    sharedClaudeObj = JSON.parse(replacedClaudeShared);
  } catch (err) {
    console.error(`Lỗi: Parse JSON thất bại cho ${claudeSharedPath}: ${err.message}`);
    process.exit(1);
  }
  try {
    sharedAgyObj = JSON.parse(replacedAgyShared);
  } catch (err) {
    console.error(`Lỗi: Parse JSON thất bại cho ${agySharedPath}: ${err.message}`);
    process.exit(1);
  }

  // --- 1. Claude Settings Merge ---
  const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
  let currentClaudeSettings = {};
  let claudeFileExisted = false;

  if (fs.existsSync(claudeSettingsPath)) {
    claudeFileExisted = true;
    try {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf8');
      currentClaudeSettings = JSON.parse(raw);
    } catch (err) {
      console.error(`Lỗi: Không thể parse JSON từ ${claudeSettingsPath}: ${err.message}`);
      process.exit(1);
    }
  }

  if (!currentClaudeSettings || typeof currentClaudeSettings !== 'object' || Array.isArray(currentClaudeSettings)) {
    currentClaudeSettings = {};
  }

  const sharedHooks = sharedClaudeObj.hooks || {};
  let claudeCommandsAdded = 0;
  let claudeMatchersUpdated = 0;

  if (!currentClaudeSettings.hooks || typeof currentClaudeSettings.hooks !== 'object' || Array.isArray(currentClaudeSettings.hooks)) {
    currentClaudeSettings.hooks = {};
  }

  for (const event of Object.keys(sharedHooks)) {
    const sharedGroups = Array.isArray(sharedHooks[event]) ? sharedHooks[event] : [];
    if (!Array.isArray(currentClaudeSettings.hooks[event])) {
      currentClaudeSettings.hooks[event] = [];
    }
    const currentGroups = currentClaudeSettings.hooks[event];

    const existingHookKeys = new Set();
    const groupOfKey = new Map();
    for (const g of currentGroups) {
      if (g && Array.isArray(g.hooks)) {
        for (const h of g.hooks) {
          const k = getHookKey(h, isWin);
          if (k) {
            existingHookKeys.add(k);
            if (!groupOfKey.has(k)) groupOfKey.set(k, g);
          }
        }
      }
    }

    for (const sGroup of sharedGroups) {
      const sHooks = (sGroup && Array.isArray(sGroup.hooks)) ? sGroup.hooks : [];
      const newHooks = [];

      for (const h of sHooks) {
        const k = getHookKey(h, isWin);
        // A harness hook already installed alone in its group, under another matcher (the shared
        // file widened or narrowed it): take the shared matcher. A group the user shares with
        // other hooks is left alone.
        const had = k && groupOfKey.get(k);
        if (had && had.hooks.length === 1 && sGroup.matcher !== undefined && had.matcher !== sGroup.matcher) {
          had.matcher = sGroup.matcher;
          claudeMatchersUpdated++;
        }
        if (k && !existingHookKeys.has(k)) {
          let hookToAdd;
          if (isWin) {
            const tokens = splitShellTokens(h.command);
            hookToAdd = {
              type: 'command',
              command: tokens[0].replace(/\\/g, '/'),
              args: tokens.slice(1).map(t => t.replace(/\\/g, '/')),
            };
            for (const prop of Object.keys(h)) {
              if (prop !== 'type' && prop !== 'command' && prop !== 'args') {
                hookToAdd[prop] = h[prop];
              }
            }
          } else {
            hookToAdd = JSON.parse(JSON.stringify(h));
          }
          newHooks.push(hookToAdd);
          existingHookKeys.add(k);
        }
      }

      if (newHooks.length > 0) {
        const newGroup = {};
        if (sGroup.matcher !== undefined) {
          newGroup.matcher = sGroup.matcher;
        }
        newGroup.hooks = newHooks;
        for (const prop of Object.keys(sGroup)) {
          if (prop !== 'matcher' && prop !== 'hooks') {
            newGroup[prop] = sGroup[prop];
          }
        }
        currentGroups.push(newGroup);
        claudeCommandsAdded += newHooks.length;
      }
    }
  }

  // A hook pointing at a script under ~/.claude/hooks that no longer exists (the repo dropped it and
  // the installer removed its link) would error on every call: drop it, and a group it leaves empty.
  const hooksDir = path.join(homeDir, '.claude', 'hooks').replace(/\\/g, '/');
  const norm = (p) => (isWin ? p.toLowerCase() : p);
  let claudeCommandsRemoved = 0;
  for (const event of Object.keys(currentClaudeSettings.hooks)) {
    const groups = currentClaudeSettings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) continue;
      g.hooks = g.hooks.filter((h) => {
        const k = getHookKey(h, isWin);
        const script = k && k.startsWith('cjs:') ? k.slice(4).split(' ')[0] : null;
        const dead = script && norm(script).startsWith(norm(hooksDir + '/')) && !fs.existsSync(script);
        if (dead) claudeCommandsRemoved++;
        return !dead;
      });
    }
    currentClaudeSettings.hooks[event] = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length > 0);
  }

  if (claudeCommandsAdded > 0 || claudeMatchersUpdated > 0 || claudeCommandsRemoved > 0) {
    if (!dryRun) {
      if (claudeFileExisted) {
        const backupTarget = path.join(backupDir, '.claude', 'settings.json');
        fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
        fs.copyFileSync(claudeSettingsPath, backupTarget);
      }
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(currentClaudeSettings, null, 2) + '\n', 'utf8');
    }
  }

  // --- 2. Antigravity (agy) Merge ---
  const agyDir = path.join(homeDir, '.gemini', 'config');
  let agyStatus = '';

  if (!fs.existsSync(agyDir) || !fs.statSync(agyDir).isDirectory()) {
    agyStatus = 'bỏ qua (thư mục .gemini/config không tồn tại)';
  } else {
    const agyHooksPath = path.join(agyDir, 'hooks.json');
    let currentAgyHooks = {};
    let agyFileExisted = false;

    if (fs.existsSync(agyHooksPath)) {
      agyFileExisted = true;
      try {
        const raw = fs.readFileSync(agyHooksPath, 'utf8');
        currentAgyHooks = JSON.parse(raw);
      } catch (err) {
        console.error(`Lỗi: Không thể parse JSON từ ${agyHooksPath}: ${err.message}`);
        process.exit(1);
      }
    }

    if (!currentAgyHooks || typeof currentAgyHooks !== 'object' || Array.isArray(currentAgyHooks)) {
      currentAgyHooks = {};
    }

    const sharedBridge = sharedAgyObj['claude-bridge'];

    if (!('claude-bridge' in currentAgyHooks)) {
      currentAgyHooks['claude-bridge'] = sharedBridge;
      agyStatus = 'đã thêm claude-bridge';
      if (!dryRun) {
        if (agyFileExisted) {
          const agyBackupTarget = path.join(backupDir, '.gemini', 'config', 'hooks.json');
          fs.mkdirSync(path.dirname(agyBackupTarget), { recursive: true });
          fs.copyFileSync(agyHooksPath, agyBackupTarget);
        }
        fs.mkdirSync(path.dirname(agyHooksPath), { recursive: true });
        fs.writeFileSync(agyHooksPath, JSON.stringify(currentAgyHooks, null, 2) + '\n', 'utf8');
      }
    } else {
      if (deepEqual(currentAgyHooks['claude-bridge'], sharedBridge)) {
        agyStatus = 'đã có và giống hệt (bỏ qua)';
      } else {
        console.log(`Thông báo: khoá claude-bridge trong ${agyHooksPath} khác cấu hình shared, giữ nguyên cấu hình hiện tại.`);
        agyStatus = 'khác biệt (giữ nguyên, không ghi đè)';
      }
    }
  }

  // --- 3. Summary ---
  console.log(`Claude hooks: đã thêm ${claudeCommandsAdded} lệnh, cập nhật matcher ${claudeMatchersUpdated} lệnh, gỡ ${claudeCommandsRemoved} lệnh trỏ tới file đã xoá.`);
  console.log(`Agy hooks: ${agyStatus}.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  getHookKey,
  splitShellTokens,
  replacePlaceholders,
  replaceAgyPlaceholders,
  deepEqual,
};

#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

function usage() {
  console.log(`Cách dùng: ${path.basename(process.argv[1] || 'install.cjs')} [--home <dir>] [--dry-run]`);
  console.log('  --home <dir>   Chỉ định thư mục home (mặc định: $HOME)');
  console.log('  --dry-run      Chỉ in các thao tác sẽ thực hiện, không thay đổi gì');
  process.exit(0);
}

function getNodeBin() {
  if (process.platform === 'win32') {
    return process.execPath;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'node');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_) {}
  }
  return process.execPath;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let homeDir = '';
  let nodeBin = getNodeBin();
  let dryRun = false;

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
      nodeBin = args[++i];
    } else if (arg.startsWith('--node=')) {
      nodeBin = arg.slice(7);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '-h' || arg === '--help') {
      usage();
    } else {
      console.error(`Lỗi: Tuỳ chọn không hợp lệ: ${arg}`);
      usage();
    }
  }

  if (!homeDir) {
    homeDir = os.homedir();
  }

  if (!homeDir) {
    console.error('Lỗi: Không xác định được thư mục HOME.');
    process.exit(1);
  }

  homeDir = path.resolve(homeDir);
  nodeBin = path.resolve(nodeBin);
  return { homeDir, nodeBin, dryRun };
}

function stripExtendedPrefix(p) {
  if (p.startsWith('\\\\?\\') || p.startsWith('\\??\\')) {
    return p.slice(4);
  }
  return p;
}

function isSameLink(target, src) {
  try {
    const st = fs.lstatSync(target);
    if (!st.isSymbolicLink()) return false;
    let dest = stripExtendedPrefix(fs.readlinkSync(target));
    const normDest = path.resolve(path.dirname(target), dest);
    const normSrc = path.resolve(stripExtendedPrefix(src));
    if (process.platform === 'win32') {
      return normDest.toLowerCase() === normSrc.toLowerCase();
    }
    return normDest === normSrc;
  } catch (_) {
    return false;
  }
}

function existsOrLink(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (_) {
    return false;
  }
}

function backupItem(target, homeDir, backupDir, dryRun) {
  const relTarget = path.relative(homeDir, target);
  const backupTarget = path.join(backupDir, relTarget);
  if (dryRun) {
    console.log(`[dry-run] Sao lưu: ${target} -> ${backupTarget}`);
    return;
  }
  fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
  fs.renameSync(target, backupTarget);
  console.log(`Đã sao lưu: ${target} -> ${backupTarget}`);
}

function installFileSymlink(src, target, homeDir, backupDir, dryRun) {
  if (isSameLink(target, src)) {
    console.log(`Đã có: ${target} -> ${src}`);
    return;
  }
  if (existsOrLink(target)) {
    backupItem(target, homeDir, backupDir, dryRun);
  }
  if (dryRun) {
    console.log(`[dry-run] Tạo symlink: ${target} -> ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpTarget = `${target}.harness-tmp`;
  try { fs.unlinkSync(tmpTarget); } catch (_) {}
  try {
    fs.symlinkSync(src, tmpTarget, 'file');
  } catch (err) {
    try { fs.unlinkSync(tmpTarget); } catch (_) {}
    if (err.code === 'EPERM' || (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES'))) {
      console.error('Lỗi: Không thể tạo symlink do thiếu quyền (EPERM).');
      console.error('Trên Windows, vui lòng bật Developer Mode (Settings → System → For developers)');
      console.error('hoặc chạy terminal với quyền Administrator để cho phép tạo symlink.');
      process.exit(1);
    }
    throw err;
  }
  fs.renameSync(tmpTarget, target);
  console.log(`Đã tạo symlink: ${target} -> ${src}`);
}

function installSkillSymlink(src, target, homeDir, backupDir, dryRun) {
  if (isSameLink(target, src)) {
    console.log(`Đã có: ${target} -> ${src}`);
    return;
  }
  if (existsOrLink(target)) {
    backupItem(target, homeDir, backupDir, dryRun);
  }
  if (dryRun) {
    console.log(`[dry-run] Tạo symlink skill: ${target} -> ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(src, target, type);
  console.log(`Đã tạo symlink skill: ${target} -> ${src}`);
}

function collectFiles(dir, filter) {
  const results = [];
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(currentDir, ent.name);
      if (ent.isDirectory()) {
        if (!filter || filter(fullPath, true)) walk(fullPath);
      } else if (ent.isFile()) {
        if (!filter || filter(fullPath, false)) results.push(fullPath);
      }
    }
  }
  walk(dir);
  return results;
}

function main() {
  const { homeDir, nodeBin, dryRun } = parseArgs();
  const repoDir = path.resolve(__dirname);

  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const backupDir = path.join(homeDir, '.claude', 'backups', `harness-install-${ts}`);

  // 1. Cài symlink claude files (trừ skills)
  const claudeDir = path.join(repoDir, 'claude');
  const claudeFiles = collectFiles(claudeDir, (p, isDir) => {
    const rel = path.relative(claudeDir, p);
    if (rel.split(path.sep)[0] === 'skills') return false;
    if (!isDir && path.basename(p) === '.DS_Store') return false;
    return true;
  }).sort((a, b) => {
    const relA = path.relative(repoDir, a).split(path.sep).join('/');
    const relB = path.relative(repoDir, b).split(path.sep).join('/');
    return relA.localeCompare(relB);
  });

  for (const src of claudeFiles) {
    const relClaude = path.relative(claudeDir, src);
    const target = path.join(homeDir, '.claude', relClaude);
    installFileSymlink(src, target, homeDir, backupDir, dryRun);
  }

  // 2. Cài symlink claude skills (nguyên thư mục)
  const skillsDir = path.join(repoDir, 'claude', 'skills');
  if (fs.existsSync(skillsDir)) {
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(ent => ent.isDirectory())
      .map(ent => ent.name)
      .sort();
    for (const skillName of skillEntries) {
      const src = path.join(skillsDir, skillName);
      const target = path.join(homeDir, '.claude', 'skills', skillName);
      installSkillSymlink(src, target, homeDir, backupDir, dryRun);
    }
  }

  // 3. Cài symlink agy files
  const agyDir = path.join(repoDir, 'agy');
  const agyFiles = collectFiles(agyDir, (p, isDir) => {
    if (!isDir) {
      const base = path.basename(p);
      if (base === '.DS_Store' || base === 'local.json' || base === 'tested-versions.json') return false;
    }
    return true;
  }).sort((a, b) => {
    const relA = path.relative(repoDir, a).split(path.sep).join('/');
    const relB = path.relative(repoDir, b).split(path.sep).join('/');
    return relA.localeCompare(relB);
  });

  for (const src of agyFiles) {
    const relAgy = path.relative(agyDir, src);
    const target = path.join(homeDir, '.gemini', 'config', relAgy);
    installFileSymlink(src, target, homeDir, backupDir, dryRun);
  }

  // 4. Copy templates/rules-mine/*.md
  const templatesDir = path.join(repoDir, 'templates', 'rules-mine');
  if (fs.existsSync(templatesDir)) {
    const templateFiles = fs.readdirSync(templatesDir)
      .filter(f => f.endsWith('.md'))
      .sort();
    for (const fname of templateFiles) {
      const t = path.join(templatesDir, fname);
      const target = path.join(homeDir, '.claude', 'rules', 'mine', fname);
      if (existsOrLink(target)) {
        console.log(`Đã có template: ${target} (bỏ qua)`);
      } else {
        if (dryRun) {
          console.log(`[dry-run] Copy template: ${t} -> ${target}`);
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(t, target);
          console.log(`Đã copy template: ${target}`);
        }
      }
    }
  }

  // 5. Gộp hook bằng Node
  const mergeHooksScript = path.join(repoDir, 'tools', 'merge-hooks.cjs');
  const mergeArgs = [
    mergeHooksScript,
    '--home', homeDir,
    '--node', nodeBin,
    '--backup-dir', backupDir,
  ];
  if (dryRun) {
    mergeArgs.push('--dry-run');
  }
  const mergeRes = child_process.spawnSync(process.execPath, mergeArgs, { stdio: 'inherit' });
  if (mergeRes.status !== 0) {
    process.exit(mergeRes.status || 1);
  }

  // 6. Kiểm tra các guard phụ thuộc AgentKit
  const missingGuards = [
    path.join(homeDir, '.claude', 'hooks', 'lib', 'privacy-checker.cjs'),
    path.join(homeDir, '.claude', 'hooks', 'lib', 'scout-checker.cjs'),
    path.join(homeDir, '.claude', 'hooks', 'lib', 'secret-keywords.cjs'),
  ].some(f => !fs.existsSync(f));

  if (missingGuards) {
    console.log('bridge agy sẽ chạy thiếu guard privacy/scout/secret: các file này thuộc AgentKit, không có trong repo');
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  main,
  isSameLink,
  existsOrLink,
  backupItem,
  installFileSymlink,
  installSkillSymlink,
  collectFiles,
  parseArgs,
};

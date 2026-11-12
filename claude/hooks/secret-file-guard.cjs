#!/usr/bin/env node
'use strict';

/**
 * secret-file-guard.cjs - keeps secret values out of the conversation, in place of AgentKit's
 * privacy-block (turned off with `ak config prefs set hooks.privacy-block false`).
 * Closed blocklist: blocks ordinary calls that print a secret file's content into the conversation:
 * - Reading or printing a secret file in Bash/PowerShell (command names matched case-insensitively):
 *   `cat`, `head`, `tail`, `less`, `more`, `bat`, `get-content`/`gc`/`type`,
 *   `grep`/`egrep`/`fgrep`/`rg`/`select-string`/`sls` that print matching lines, `cut`,
 *   `awk`/`gawk`, `sed` without `-i`/`--in-place`, `<`/`<>` into one of those printing commands,
 *   `base64`, `xxd`, `strings`.
 * - The `Read` and `Edit`/`MultiEdit` tools on a secret file (`Write` and `.pub` public keys pass).
 * - Loading a secret file (`source`, `.`) in the same command as shell trace (`set -x`, `set -v`,
 *   `set -o xtrace|verbose`) or a variable-printing command (`env` with no command to run,
 *   `printenv`, bare `set`, `export -p`, `declare -p`, `echo`/`printf` naming a key the loaded file
 *   sets; `echo exit=$?` or a variable the file does not set passes; an unreadable file counts
 *   every named variable).
 * Everything else naming a secret file (`set -a; . ./.env; set +a; <cmd>`, passing its path to a
 * `python3`/`node` script, `--env-file`, `ssh -i <key>`, `cp .env.example .env`, prose in heredocs
 * or quoted strings) passes.
 * - Which paths are secret: AgentKit's `~/.claude/hooks/lib/privacy-checker.cjs` (`checkPrivacy`,
 *   required, never edited). Missing, broken or throwing checker: fail closed on `SECRETISH`.
 * - Viet approves one read: `# secret-ok: "<his words, 8+ chars>"` matched against `userTexts`.
 * Known limits: a script (`python3 x.py ./.env`, `node app.js`) or unlisted subcommand (`git diff` /
 * `git show` on a dotenv) that prints secret values itself, command substitution feeding a dotenv
 * into `export`/`env` without `source`/`.`, or an unquoted dotenv line that fails shell parsing, is
 * not caught; this hook is a guardrail naming the risk on ordinary commands, never a wall.
 * Fails open on an unexpected internal error of the guard itself (checker failure fails closed).
 */

const os = require('os');
const path = require('path');
const { commands, program, dropHeredocs } = require('./lib/shell-words.cjs');

const KIT_CHECKER = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'privacy-checker.cjs');
const DOTENV = /^(\.env(\.[\w.-]+)?|[\w.-]+\.env)$/i;
const SAFE = /\.(example|sample|template|dist|pub)$/i;
const SECRETISH = /(^|[\s/"'=<>])(\.env(\.[\w.-]+)?|[\w.-]+\.env|id_(rsa|dsa|ecdsa|ed25519)[\w.-]*|[\w.-]+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.[\w-]+)?|secrets?\.ya?ml)(?=$|[\s"';&|)<>])/i;
const SIMPLE_PRINTERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'cut', 'base64', 'xxd', 'strings',
  'get-content', 'gc', 'type', 'select-string', 'sls',
]);
const GREP_OPT_VAL = /^(--(max-count|after-context|before-context|context|label|include|exclude|exclude-dir|color|colour|directories|binary-files))$/;
const REDIR = /(\d*<<<|\d*<<-?|\d*<>|&>>?|\d*>>?&?|\d*<&?)/;
const APPROVAL = /#\s*secret-ok:\s*"([^"\n]{8,})"/;
const norm = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim();

function loadChecker() {
  try {
    const kit = require(KIT_CHECKER);
    return typeof kit.checkPrivacy === 'function' ? kit : null;
  } catch {
    return null;
  }
}

function isDotenv(filePath) {
  const b = path.basename(String(filePath).replace(/\\/g, '/').replace(/^APPROVED:/, ''));
  return b !== '' && DOTENV.test(b) && !SAFE.test(b);
}

function fallbackPaths(text) {
  const paths = [];
  const re = new RegExp(SECRETISH.source, 'gi');
  for (let m; (m = re.exec(text)); ) if (!SAFE.test(m[2])) paths.push(m[2]);
  return paths;
}

// Separate redirections from argv on one simple command: `<`/`<>` targets go to stdinFiles; output/heredoc targets drop.
function splitRedirects(words) {
  const argv = [];
  const stdinFiles = [];
  let pendingOp = null;
  for (const w of words) {
    if (/\s/.test(w) || /^<[^<>]+>$/.test(w)) {
      if (pendingOp === null) argv.push(w);
      else if (/^\d*<>$/.test(pendingOp) || /^\d*<$/.test(pendingOp)) stdinFiles.push(w);
      pendingOp = null;
      continue;
    }
    const parts = String(w).split(REDIR);
    const standalone = parts.length === 3 && parts[0] === '' && parts[2] === '';
    for (let k = 0; k < parts.length; k += 2) {
      const text = parts[k];
      if (text !== '') {
        if (pendingOp !== null) {
          if (/^\d*<>$/.test(pendingOp) || /^\d*<$/.test(pendingOp)) stdinFiles.push(text);
          pendingOp = null;
        } else {
          argv.push(text);
        }
      }
      if (k + 1 < parts.length) pendingOp = parts[k + 1];
    }
    if (!standalone) pendingOp = null;
  }
  return { argv, stdinFiles };
}

function grepFiles(args) {
  const pos = [];
  let hasPat = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!opts) { pos.push(a); continue; }
    if (a === '--') { opts = false; continue; }
    if (/^--(quiet|silent|count|files-with(out)?-match(es)?)$/.test(a)) return null;
    if (/^--regexp=/.test(a)) { hasPat = true; continue; }
    if (a === '--regexp') { hasPat = true; i++; continue; }
    if (GREP_OPT_VAL.test(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    if (!a.startsWith('-')) { pos.push(a); continue; }
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if ('qclL'.includes(ch)) return null;
      if (ch === 'e') { hasPat = true; if (k === letters.length - 1) i++; break; }
      if ('mABCdf'.includes(ch)) { if (ch === 'f') hasPat = true; if (k === letters.length - 1) i++; break; }
    }
  }
  return hasPat ? pos : pos.slice(1);
}

function sedFiles(args) {
  const pos = [];
  let hasScript = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!opts) { pos.push(a); continue; }
    if (a === '--') { opts = false; continue; }
    if (/^--in-place(=|$)/.test(a)) return null;
    if (/^--expression=/.test(a)) { hasScript = true; continue; }
    if (a === '--expression') { hasScript = true; i++; continue; }
    if (a.startsWith('--')) continue;
    if (!a.startsWith('-')) { pos.push(a); continue; }
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if (ch === 'i') return null;
      if (ch === 'e' || ch === 'f') { hasScript = true; if (k === letters.length - 1) i++; break; }
    }
  }
  return hasScript ? pos : pos.slice(1);
}

function awkFiles(args) {
  const pos = [];
  let hasProgFile = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!opts) { pos.push(a); continue; }
    if (a === '--') { opts = false; continue; }
    if (a.startsWith('--')) continue;
    if (!a.startsWith('-')) { pos.push(a); continue; }
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if ('fFv'.includes(ch)) { if (ch === 'f') hasProgFile = true; if (k === letters.length - 1) i++; break; }
    }
  }
  return (hasProgFile ? pos : pos.slice(1)).filter((w) => !/^\w+=/.test(w));
}

function printerFiles(name, args) {
  if (SIMPLE_PRINTERS.has(name)) {
    const out = [];
    let opts = true;
    for (const a of args) {
      if (!opts) out.push(a);
      else if (a === '--') opts = false;
      else if (!a.startsWith('-')) out.push(a);
    }
    return out;
  }
  if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg') return grepFiles(args);
  if (name === 'sed') return sedFiles(args);
  if (name === 'awk' || name === 'gawk') return awkFiles(args);
  return null;
}

function setsTrace(args) {
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '-o' && /^(xtrace|verbose)$/.test(args[i + 1] || '')) return true;
    if (/^-[a-zA-Z]*[xv]/.test(args[i]) && args[i] !== '-o') return true;
  }
  return false;
}

// `all`: the command prints every variable (env, printenv, bare set, export/declare -p).
// `names`: the variables an echo/printf prints (`$X`, `${X}`; `$?`, `$1` are no variables).
function printsVars(argv, prog) {
  if (prog.length === 0) return { all: argv.some((w) => !/^\w+=/.test(w) && path.basename(w.replace(/\\/g, '/')).toLowerCase() === 'env'), names: [] };
  const name = (prog[0] || '').replace(/^.*[\\/]/, '').toLowerCase();
  const args = prog.slice(1);
  if (name === 'printenv') return { all: true, names: [] };
  if (name === 'set') return { all: args.length === 0, names: [] };
  if (name === 'export' || name === 'declare') return { all: args.some((a) => /^-[a-zA-Z]*p/.test(a)), names: [] };
  if (name === 'echo' || name === 'printf') {
    const names = args.flatMap((a) => [...a.matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1]));
    return { all: false, names };
  }
  return { all: false, names: [] };
}

// The keys a dotenv-style file sets, or null when it cannot be read. Values are never kept.
function keysOf(file, cwd) {
  try {
    const text = require('fs').readFileSync(path.resolve(cwd || process.cwd(), String(file).replace(/^~(?=\/)/, os.homedir())), 'utf8');
    return new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]));
  } catch {
    return null;
  }
}

function printedSecrets(command, isSecret, cwd) {
  const leaked = [];
  const sourced = [];
  let printsAll = false;
  const named = [];
  let moved = false; // a `cd`/`pushd`/`env -C`/`sudo -D` ran before: a relative path no longer resolves from cwd
  for (const words of commands(command)) {
    const { argv, stdinFiles } = splitRedirects(words);
    const prog = program(argv);
    const name = (prog[0] || '').replace(/^.*[\\/]/, '').toLowerCase();
    const args = prog.slice(1);
    if (name === 'cd' || name === 'pushd' || prog.chdir !== undefined) moved = true;
    if ((name === 'source' || name === '.') && args[0] && isSecret(args[0])) sourced.push({ file: args[0], moved });
    const files = printerFiles(name, args);
    if (files !== null) {
      for (const f of [...files, ...stdinFiles]) if (isSecret(f)) leaked.push(f);
    }
    const vars = printsVars(argv, prog);
    if ((name === 'set' && setsTrace(args)) || vars.all) printsAll = true;
    named.push(...vars.names);
  }
  for (const { file, moved: after } of sourced) {
    const keys = after && !path.isAbsolute(file.replace(/^~(?=\/)/, os.homedir())) ? null : keysOf(file, cwd);
    if (printsAll || named.some((n) => keys === null || keys.has(n))) leaked.push(file);
  }
  return [...new Set(leaked)];
}

function approved(command, transcript, userTexts) {
  const m = APPROVAL.exec(command || '');
  if (!m || !transcript) return false;
  const quote = norm(m[1]);
  return userTexts(transcript).some((t) => norm(t).includes(quote));
}

// The verdict on one call: { deny, paths, fallback, uninspectable, onlyDotenv, reason }.
function judge(data, { checker = loadChecker(), userTexts = require('./lib/user-intent.cjs').userTexts } = {}) {
  const tool = data.tool_name || '';
  const toolInput = data.tool_input || {};
  const isShell = tool === 'Bash' || tool === 'PowerShell';
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const pass = { deny: false, paths: [] };

  let checked = null;
  if (checker) {
    try {
      checked = checker.checkPrivacy({
        toolName: tool,
        toolInput: isShell ? { ...toolInput, command: dropHeredocs(command) } : toolInput,
        options: { cwd: data.cwd },
      });
    } catch {
      checked = null;
    }
  }
  if (!checked) {
    const paths = fallbackPaths(isShell ? command : String(toolInput.file_path || toolInput.path || ''));
    if (paths.length === 0 || (command && approved(command, data.transcript_path, userTexts))) return pass;
    return { deny: true, paths, fallback: true, uninspectable: false, onlyDotenv: false, reason: undefined };
  }
  if (checked.uninspectable) {
    if (command && approved(command, data.transcript_path, userTexts)) return pass;
    return { deny: true, paths: [], fallback: false, uninspectable: true, onlyDotenv: false, reason: checked.reason };
  }
  if (!isShell) {
    if (tool === 'Write') return pass;
    const paths = (checked.blocked ? (checked.accesses || []).map((a) => a.filePath) : [])
      .filter((p) => !SAFE.test(String(p).replace(/^[`'"]+|[`'"]+$/g, '')));
    if (paths.length === 0) return pass;
    return { deny: true, paths, fallback: false, uninspectable: false, onlyDotenv: paths.every(isDotenv), reason: checked.reason };
  }

  const isSecret = (filePath) => {
    const clean = String(filePath).replace(/\\/g, '/').replace(/^APPROVED:/, '');
    const base = path.basename(clean);
    if (!base || clean.startsWith('-') || SAFE.test(base)) return false;
    return Boolean(checker.checkPrivacy({ toolName: 'Read', toolInput: { file_path: clean }, options: { cwd: data.cwd } }).blocked);
  };
  const paths = printedSecrets(command, isSecret, data.cwd);
  if (paths.length === 0 || approved(command, data.transcript_path, userTexts)) return pass;
  return { deny: true, paths, fallback: false, uninspectable: false, onlyDotenv: paths.every(isDotenv), reason: undefined };
}

// '' to let the call run, else the reason it is denied.
function decide(data, opts = {}) {
  const tool = data.tool_name || '';
  const access = judge(data, opts);
  if (!access.deny) return '';
  if (access.fallback) {
    return (
      `secret-file-guard: AgentKit's privacy checker (${KIT_CHECKER}) did not load or failed, so every call naming a ` +
      `secret-looking path is denied (${access.paths.join(', ')}). Tell Viet: an \`ak update\` may have moved it; ` +
      'until it loads again, a read he approves carries `# secret-ok: "<his exact words>"`.'
    );
  }
  const what = access.uninspectable ? access.reason || 'a command this guard cannot read' : access.paths.join(', ');
  return (
    `secret-file-guard: this ${tool} call would print a secret file into the conversation (${what}). ` +
    (access.onlyDotenv
      ? 'Use the file without printing it: `set -a; . ./.env; set +a; <command>`, `--env-file=<file>`, ' +
        'or pass its path to a script that parses it without printing (`grep -q`/`grep -c \'^KEY=\' <file>` to check a key is set). '
      : 'Keys and credentials stay unprinted; pass the path to a command or script that uses it without printing. ') +
    'If Viet must see a value, ask him; once he agrees, rerun the Bash command with the comment ' +
    '`# secret-ok: "<his exact words, 8+ characters>"`, and print only what he asked for.'
  );
}

module.exports = { decide, judge, printedSecrets };
if (require.main !== module) return;

try {
  const data = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const why = decide(data);
  if (why) {
    process.stderr.write(`${why}\n`);
    process.exit(2);
  }
} catch {
  // fail open
}
process.exit(0);

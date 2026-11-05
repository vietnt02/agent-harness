#!/usr/bin/env node
'use strict';

/**
 * secret-file-guard.cjs - keeps secret values out of the conversation, in place of AgentKit's
 * privacy-block (turned off with `ak config prefs set hooks.privacy-block false`). The risk is a
 * value entering the transcript, so the guard judges what a call prints, not which file it names.
 * - Which paths a call touches and which of them are secret: AgentKit's own checker
 *   (`~/.claude/hooks/lib/privacy-checker.cjs` `checkPrivacy`, required, never edited: editing a kit
 *   lib makes `ak update` abort), so key and credential patterns follow kit updates. No checker
 *   (missing, API changed): a call naming a secret-looking path (SECRETISH) counts as touching it.
 * - A dotenv file (`.env`, `.env.local`, `local.env`) passes in a Bash command that uses it without
 *   printing it (quietUse): loading (`source`, `.`, `--env-file`), testing or listing (`test`, `[`,
 *   `ls`, `stat`), moving (`cp`, `mv`, `ln`, `chmod`, `touch`, `rm`), counting (`wc`, `grep -c|-q|-l`),
 *   key names (`cut -d= -f1`), writing (`>`, `>>`); and in the Write tool. Any directory, a symlink too.
 * - Everything else the checker flags is denied: printing a dotenv (`cat`, `grep` with lines, a
 *   pipe, `<`, the Read and Edit tools), any other secret file, a command the checker cannot read.
 * - Viet approves one read: the Bash command carries `# secret-ok: "<his words>"` and those words
 *   are in one of his messages this session (worker-default-guard `userTexts`).
 * Known limit: a command that loads a dotenv and then prints a variable (`source .env; echo $K`) is
 * not seen; secret-output-guardrail's reminder is what covers it.
 * Fails open on an internal error.
 */

const os = require('os');
const path = require('path');
const { commands, program } = require('./lib/shell-words.cjs');

const KIT_CHECKER = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'privacy-checker.cjs');
const DOTENV = /^(\.env(\.[\w.-]+)?|[\w.-]+\.env)$/i;
const SAFE = /\.(example|sample|template|dist)$/i;
const SECRETISH = /(^|[\s/"'=<>])(\.env(\.[\w.-]+)?|[\w.-]+\.env|id_(rsa|dsa|ecdsa|ed25519)[\w.-]*|[\w.-]+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.[\w-]+)?)(?=$|[\s"';&|)<>])/i;
const QUIET = new Set(['source', '.', 'test', '[', 'ls', 'stat', 'cp', 'mv', 'ln', 'chmod', 'touch', 'rm', 'wc']);
const APPROVAL = /#\s*secret-ok:\s*"([^"\n]+)"/;

// The file a word names: `--env-file=.env` names `.env`.
const base = (p) => path.basename(String(p).replace(/\\/g, '/').replace(/^APPROVED:/, '').replace(/^-[\w-]*=/, ''));
const isDotenv = (p) => DOTENV.test(base(p)) && !SAFE.test(base(p));
const norm = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim();

function loadChecker() {
  try {
    const kit = require(KIT_CHECKER);
    return typeof kit.checkPrivacy === 'function' ? kit : null;
  } catch {
    return null;
  }
}

// The secret paths a call touches: { paths, uninspectable }.
function secretAccess(data, checker) {
  const toolInput = data.tool_input || {};
  if (checker) {
    const r = checker.checkPrivacy({ toolName: data.tool_name, toolInput, options: { cwd: data.cwd } });
    if (!r.blocked) return { paths: [], uninspectable: false };
    return { paths: (r.accesses || []).map((a) => a.filePath), uninspectable: Boolean(r.uninspectable), reason: r.reason };
  }
  const text = typeof toolInput.command === 'string' ? toolInput.command : String(toolInput.file_path || toolInput.path || '');
  const paths = [];
  const re = new RegExp(SECRETISH.source, 'gi');
  for (let m; (m = re.exec(text)); ) if (!SAFE.test(m[2])) paths.push(m[2]);
  return { paths, uninspectable: false };
}

// The word names a dotenv file, written bare or as a redirect (`>.env`, `<.env`).
const dotenvIn = (w) => isDotenv(w.replace(/^\d*[<>]+/, '')) && w.replace(/^\d*[<>]+/, '') !== '';

// True when every simple command naming a dotenv uses it without printing its values.
function quietUse(command) {
  for (const words of commands(command)) {
    if (!words.some((w) => dotenvIn(w) || /^--env-file=/.test(w))) continue;
    const prog = program(words);
    const name = prog[0] || '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!dotenvIn(w)) continue;
      const prev = words[i - 1] || '';
      if (/^--env-file=/.test(w) || prev === '--env-file') continue;
      if (/^\d*>{1,2}/.test(w) || /^\d*>{1,2}$/.test(prev)) continue; // written to, not read
      if (/^\d*</.test(w) || /^\d*<$/.test(prev)) return false; // fed into a command
      if (QUIET.has(name)) continue;
      const flags = prog.filter((x) => /^-[A-Za-z]/.test(x)).join(' ');
      if (name === 'grep' && /(^|\s)-[A-Za-z]*[qcl]/.test(flags)) continue;
      if (name === 'cut' && /(^|\s)-f\s*1(\s|$)/.test(`${prog.join(' ')} `) && /-d\s*=/.test(prog.join(' '))) continue;
      return false;
    }
  }
  return true;
}

function approved(command, transcript, userTexts) {
  const m = APPROVAL.exec(command || '');
  if (!m || !transcript) return false;
  const quote = norm(m[1]);
  return quote.length > 1 && userTexts(transcript).some((t) => norm(t).includes(quote));
}

// '' to let the call run, else the reason it is denied.
function decide(data, { checker = loadChecker(), userTexts = require('./worker-default-guard.cjs').userTexts } = {}) {
  const tool = data.tool_name || '';
  const access = secretAccess(data, checker);
  if (!access.uninspectable && access.paths.length === 0) return '';
  const command = typeof (data.tool_input || {}).command === 'string' ? data.tool_input.command : '';
  if (command && approved(command, data.transcript_path, userTexts)) return '';
  const onlyDotenv = !access.uninspectable && access.paths.every(isDotenv);
  if (onlyDotenv && tool === 'Bash' && quietUse(command)) return '';
  if (onlyDotenv && tool === 'Write') return '';
  const what = access.uninspectable ? access.reason || 'a command this guard cannot read' : access.paths.join(', ');
  return (
    `secret-file-guard: this ${tool} call would print a secret file into the conversation (${what}). ` +
    (onlyDotenv
      ? 'Use the file without printing it: `source`/`set -a; . <file>`, `--env-file <file>`, `test -f`, `grep -q`/`-c KEY <file>`, ' +
        '`cut -d= -f1 <file>` for key names. '
      : 'Keys and credentials stay unread. ') +
    'If Viet must see a value, ask him; once he agrees, rerun the Bash command with the comment ' +
    '`# secret-ok: "<his exact words>"`, and print only what he asked for.'
  );
}

module.exports = { decide, quietUse, isDotenv, secretAccess };
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

#!/usr/bin/env node
'use strict';

/**
 * secret-file-guard.cjs - keeps secret values out of the conversation, in place of AgentKit's
 * privacy-block (turned off with `ak config prefs set hooks.privacy-block false`). The risk is a
 * value entering the transcript, so the guard judges what a call prints, not which file it names.
 * - Which paths a call touches and which of them are secret: AgentKit's own checker
 *   (`~/.claude/hooks/lib/privacy-checker.cjs` `checkPrivacy`, required, never edited: editing a kit
 *   lib makes `ak update` abort), so key and credential patterns follow kit updates. No checker
 *   (missing, API changed, it throws): fail closed, every call naming a secret-looking path
 *   (SECRETISH) is denied with that reason, no quiet use allowed.
 * - A dotenv file (`.env`, `.env.local`, `local.env`) passes in a Bash command that uses it without
 *   printing it (quietUse), each simple command naming one judged on its own:
 *   loading it (`source`, `.`; not with `set -x`), `--env-file` for a program not asked to print
 *   (`config`, `env`, `printenv`, `-p`, `-e`, `--print`, `--eval` deny), testing or listing (`test`,
 *   `[`, `ls`, `stat`, `chmod`, `touch`, `rm`, `git check-ignore|ls-files|rm`), hashing or comparing
 *   (`sha256sum`, `shasum`, `md5`, `cmp -s`, `diff -q`), counting (`wc` without `--files0-from`,
 *   `grep -q|-c|-l|-L`, real option letters only), copying or linking between dotenv files only
 *   (`cp .env.example .env`), and writing (`>`, `>>`); and in the Write tool.
 * - Everything else the checker flags is denied: printing a dotenv (`cat`, `cut`, `grep` with
 *   lines, a pipe, `<`, `cat<.env`, an assignment `f=.env`), the Read and Edit tools, any other secret
 *   file, a command the checker cannot read.
 * - Viet approves one read: the Bash command carries `# secret-ok: "<his words>"`, 8 characters or
 *   more, found in one of his own prompts this session (worker-default-guard `userTexts`, which
 *   skips task notifications and other entries no human typed).
 * Known limits: a command that loads a dotenv then prints a variable (`source .env; echo $K`), or a
 * value the shell fails to parse (an unquoted `A=b c` prints `c: command not found`), is not seen;
 * secret-output-guardrail's reminder covers it.
 * Fails open on an internal error of the guard itself (a checker error fails closed, above).
 */

const os = require('os');
const path = require('path');
const { commands, program, innerScript } = require('./lib/shell-words.cjs');

const KIT_CHECKER = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'privacy-checker.cjs');
const DOTENV = /^(\.env(\.[\w.-]+)?|[\w.-]+\.env)$/i;
const SAFE = /\.(example|sample|template|dist)$/i;
const SECRETISH = /(^|[\s/"'=<>])(\.env(\.[\w.-]+)?|[\w.-]+\.env|id_(rsa|dsa|ecdsa|ed25519)[\w.-]*|[\w.-]+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.[\w-]+)?|secrets?\.ya?ml)(?=$|[\s"';&|)<>])/i;
// Programs that never print a file's content, whatever their arguments.
const QUIET = new Set(['source', '.', 'test', '[', 'ls', 'stat', 'chmod', 'touch', 'rm', 'sha256sum', 'shasum', 'md5', 'md5sum']);
const COPY = new Set(['cp', 'mv', 'ln']);
const GIT_QUIET = new Set(['check-ignore', 'ls-files', 'rm']);
const PRINTS = /^(config|env|printenv|set|export|-p|-e|-pe|--print|--eval)$|process\.env/;
const APPROVAL = /#\s*secret-ok:\s*"([^"\n]{8,})"/;

// The file a word names: `--env-file=.env` and `f=.env` name `.env`.
const target = (w) => String(w).replace(/\\/g, '/').replace(/^APPROVED:/, '').replace(/^[\w-]*=/, '');
const plainDotenv = (p) => {
  const b = path.basename(target(p));
  return b !== '' && DOTENV.test(b) && !SAFE.test(b);
};
// A shell word with redirects in it (`cat<.env`, `.env>out`, `2>>.env`) in pieces: [word, op, word, …].
const pieces = (w) => String(w).split(/(\d*[<>]+&?)/);
// The word names a dotenv, alone or as one piece of a redirect.
const isDotenv = (w) => pieces(w).some((x, k) => k % 2 === 0 && plainDotenv(x));
const envLike = (p) => DOTENV.test(path.basename(target(p))); // a dotenv or its template
const norm = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim();

function loadChecker() {
  try {
    const kit = require(KIT_CHECKER);
    return typeof kit.checkPrivacy === 'function' ? kit : null;
  } catch {
    return null;
  }
}

// The secret paths a call touches: { paths, uninspectable, reason, fallback }.
function secretAccess(data, checker) {
  const toolInput = data.tool_input || {};
  if (checker) {
    try {
      const r = checker.checkPrivacy({ toolName: data.tool_name, toolInput, options: { cwd: data.cwd } });
      if (!r.blocked) return { paths: [], uninspectable: false };
      return { paths: (r.accesses || []).map((a) => a.filePath), uninspectable: Boolean(r.uninspectable), reason: r.reason };
    } catch {
      // fall through to the fail-closed check
    }
  }
  const text = typeof toolInput.command === 'string' ? toolInput.command : String(toolInput.file_path || toolInput.path || '');
  const paths = [];
  const re = new RegExp(SECRETISH.source, 'gi');
  for (let m; (m = re.exec(text)); ) if (!SAFE.test(m[2])) paths.push(m[2]);
  return { paths, uninspectable: false, fallback: true };
}

// The option letters of a grep word list, stopping where patterns begin (`-e`/`-f` values, `--`).
function grepQuiet(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return false;
    if (/^--(quiet|silent|count|files-with(out)?-match(es)?)$/.test(a)) return true;
    if (/^--/.test(a) || !/^-[A-Za-z]/.test(a)) continue;
    for (const c of a.slice(1)) {
      if ('qclL'.includes(c)) return true;
      if (c === 'e' || c === 'f') break; // the rest of the word, or the next word, is a pattern
    }
  }
  return false;
}

// True when one simple command that names a dotenv uses it without printing its values.
function quietCommand(words, raw) {
  const prog = program(words);
  const name = prog[0] || '';
  const args = prog.slice(1);
  if (raw.some((w) => /^\w+=/.test(w) && isDotenv(w))) return false; // `f=.env`: used later, unseen
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    const prev = raw[i - 1] || '';
    if (/^\d*<$/.test(w) && isDotenv(raw[i + 1] || '')) return false; // `< .env` feeds it to the program
    if (/[<>]/.test(w) && !/^\d*[<>]+&?$/.test(w)) {
      // Inside one word: a dotenv only after `>` is written to; before `>` (`.env>x`) or after `<` it is read.
      const ps = pieces(w);
      for (let k = 0; k < ps.length; k += 2) if (plainDotenv(ps[k]) && !(k > 0 && />/.test(ps[k - 1]))) return false;
      continue;
    }
    if (!isDotenv(w)) continue;
    if (/^--env-file=/.test(w) || prev === '--env-file') {
      if (args.some((a) => PRINTS.test(a))) return false;
      continue;
    }
    if (/^\d*>{1,2}$/.test(prev)) continue; // `> .env`: written to, not read
    if (QUIET.has(name)) continue;
    if (name === 'wc' && !args.some((a) => /^--files0-from/.test(a))) continue;
    if (name === 'grep' && grepQuiet(args)) continue;
    if (name === 'cmp' && args.includes('-s')) continue;
    if (name === 'diff' && args.some((a) => /^(-q|--brief)$/.test(a))) continue;
    if (name === 'git' && GIT_QUIET.has(args.find((a) => !a.startsWith('-')))) continue;
    if (COPY.has(name) && args.filter((a) => !a.startsWith('-')).every(envLike)) continue;
    return false;
  }
  return true;
}

// True when every simple command naming a dotenv uses it without printing its values.
function quietUse(command) {
  if (/(^|[\s;&|])set\s+(-[a-z]*x|-o\s+xtrace)/.test(command) || /(^|[\s;&|(])(ba|z)?sh\s+-[a-z]*x/.test(command)) {
    if (commands(command).some((ws) => ws.some(isDotenv))) return false; // xtrace echoes each assignment
  }
  for (const words of commands(command)) {
    const inner = innerScript(program(words));
    if (inner !== null) {
      // `bash -c '<s>'`, `eval <s>`: the script is judged as a command; `-x` echoes it.
      const names = commands(inner).some((ws) => ws.some(isDotenv));
      if (names && program(words).some((w) => /^-[a-z]*x/.test(w))) return false;
      if (!quietUse(inner)) return false;
      continue;
    }
    if (!words.some(isDotenv)) continue;
    if (!quietCommand(words, words)) return false;
  }
  return true;
}

function approved(command, transcript, userTexts) {
  const m = APPROVAL.exec(command || '');
  if (!m || !transcript) return false;
  const quote = norm(m[1]);
  return userTexts(transcript).some((t) => norm(t).includes(quote));
}

// '' to let the call run, else the reason it is denied.
function decide(data, { checker = loadChecker(), userTexts = require('./worker-default-guard.cjs').userTexts } = {}) {
  const tool = data.tool_name || '';
  const access = secretAccess(data, checker);
  if (!access.uninspectable && access.paths.length === 0) return '';
  const command = typeof (data.tool_input || {}).command === 'string' ? data.tool_input.command : '';
  if (command && approved(command, data.transcript_path, userTexts)) return '';
  const onlyDotenv = !access.fallback && !access.uninspectable && access.paths.every(isDotenv);
  if (onlyDotenv && tool === 'Bash' && quietUse(command)) return '';
  if (onlyDotenv && tool === 'Write') return '';
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
    (onlyDotenv
      ? 'Use the file without printing it: `source <file>`, `--env-file <file>`, `test -f`, `grep -q`/`grep -c \'^KEY=\' <file>` ' +
        'to check a key is set. '
      : 'Keys and credentials stay unread. ') +
    'If Viet must see a value, ask him; once he agrees, rerun the Bash command with the comment ' +
    '`# secret-ok: "<his exact words, 8+ characters>"`, and print only what he asked for.'
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

#!/usr/bin/env node
'use strict';

/**
 * secret-file-guard.cjs - keeps secret values out of the conversation, in place of AgentKit's
 * privacy-block (turned off with `ak config prefs set hooks.privacy-block false`).
 * Closed blocklist: blocks ordinary calls that print a secret file's content into the conversation:
 * - Reading or printing a secret file in Bash/PowerShell (command names matched case-insensitively):
 *   `cat`, `head`, `tail`, `less`, `more`, `bat`, `get-content`/`gc`/`type`,
 *   `grep`/`egrep`/`fgrep`/`rg`/`select-string`/`sls` that print matching lines (`grep -o` of key
 *   names only, `^[A-Z_][A-Z0-9_]*=`, passes), `cut`,
 *   `awk`/`gawk`, `sed` without `-i`/`--in-place`, `<`/`<>` into one of those printing commands,
 *   `base64`, `xxd`, `strings`.
 * - The `Read` and `Edit`/`MultiEdit` tools on a secret file (`Write` and `.pub` public keys pass).
 * - Loading a secret file (`source`, `.`) in the same command as shell trace (`set -x`, `set -v`,
 *   `set -o xtrace|verbose`) or a variable-printing command (`env` with no command to run,
 *   `printenv`, bare `set`, `export -p`, `declare -p`, `echo`/`printf` naming a key the loaded file
 *   sets; `echo exit=$?`, `${KEY:+text}`, `${#KEY}`, a variable the file does not set, or one only passed to a `$(…)` inside
 *   the echo passes; a relative file after a `cd` resolves from its literal target; an unreadable
 *   file, or one loaded after a `cd` to an unknown place, counts every named variable). A print
 *   counts only when it runs after the load: later in the command, or in a loop around the load;
 *   one before it cannot show the file's values. Shell trace counts in any order.
 * Everything else naming a secret file (`set -a; . ./.env; set +a; <cmd>`, passing its path to a
 * `python3`/`node` script, `--env-file`, `ssh -i <key>`, `cp .env.example .env`, prose in heredocs
 * or quoted strings) passes.
 * - Which paths are secret: AgentKit's `~/.claude/hooks/lib/privacy-checker.cjs` (`checkPrivacy`,
 *   never edited). A machine without that file judges by `SECRETISH` the same way (a `source` that prints
 *   nothing passes); a checker that is there but broken or throwing: fail closed on `SECRETISH`.
 * - Viet approves one read: `# secret-ok: "<his words, 8+ chars>"` matched against what he typed
 *   (`userTexts`) or picked as an answer in an AskUserQuestion box.
 * Known limits: a script (`python3 x.py ./.env`, `node app.js`) or unlisted subcommand (`git diff` /
 * `git show` on a dotenv) that prints secret values itself, command substitution feeding a dotenv
 * into `export`/`env` without `source`/`.`, an unquoted dotenv line that fails shell parsing, a key
 * fed by `<<<` to a filter inside `$(…)` that an echo prints, or an escaped backtick (`\``) around
 * a key in an echo, is not caught; this hook is a guardrail naming the risk on ordinary commands, never a wall.
 * Secrets outside files: a command that prints process command lines or a container's config, where a
 * secret passed as a flag (`--requirepass <pw>`) or an env value sits (`docker inspect` without
 * `--format` or with one naming `.Config.Cmd|Env|Entrypoint`, `.Args`, `json .Config`, `{{json .}}`;
 * `ps -o args|command|cmd`; `/proc/<pid>/cmdline|environ`), in the command, a script it runs or one it
 * hands to ssh (lib/shell-words.cjs `scriptsRun`), is held once (lib/block-once.cjs) with how to print
 * names only: the same command run again passes.
 * Fails open on an unexpected internal error of the guard itself (checker failure fails closed).
 */

const os = require('os');
const path = require('path');
const { commands, program, innerScript, dropHeredocs, assignments, closeParen, closeTick, scriptsRun, pipedInto } = require('./lib/shell-words.cjs');

const KIT_CHECKER = path.join(os.homedir(), '.claude', 'hooks', 'lib', 'privacy-checker.cjs');
const DOTENV = /^(\.env(\.[\w.-]+)?|[\w.-]+\.env)$/i;
const SAFE = /\.(example|sample|template|dist|pub)$/i;
const SECRETISH = /(^|[\s/"'=<>])(\.env(\.[\w.-]+)?|[\w.-]+\.env|id_(rsa|dsa|ecdsa|ed25519)[\w.-]*|[\w.-]+\.(pem|key|p12|pfx|jks|keystore)|credentials(\.[\w-]+)?|secrets?\.ya?ml)(?=$|[\s"';&|)<>])/i;
const SIMPLE_PRINTERS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'bat', 'cut', 'base64', 'xxd', 'strings',
  'get-content', 'gc', 'type', 'select-string', 'sls',
]);
// A `grep -o` pattern that matches only a key name and its `=` (`^[A-Z_][A-Z0-9_]*=`, `^AWS_REGION=`):
// anchored, made of word characters, classes of word characters and `-` ranges, and quantifiers. A range
// spanning `=` (`[0-z]`) or a context option (`-A2`) still prints values: a known limit, not caught.
const KEY_NAME_PATTERN = /^\^(?:\[[\w-]+\]|\w)(?:\[[\w-]+\]|\w|[*+?])*=$/;
const GREP_OPT_VAL = /^(--(max-count|after-context|before-context|context|label|include|exclude|exclude-dir|color|colour|directories|binary-files))$/;
const REDIR = /(\d*<<<|\d*<<-?|\d*<>|&>>?|\d*>>?&?|\d*<&?)/;
const ASK_ANSWER = /^(Your questions have been answered|The user answered|User has answered)/;
const APPROVAL = /#\s*secret-ok:\s*"([^"\n]{8,})"/;
const norm = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim();

// The checker of a machine without AgentKit: a path is secret when `SECRETISH` names it.
const BUILTIN_CHECKER = {
  checkPrivacy: ({ toolInput = {} }) => {
    const paths = fallbackPaths(String(toolInput.command || toolInput.file_path || toolInput.path || ''));
    return paths.length ? { blocked: true, accesses: paths.map((filePath) => ({ filePath })) } : { blocked: false };
  },
};

function loadChecker(file = KIT_CHECKER) {
  if (!require('fs').existsSync(file)) return BUILTIN_CHECKER;
  try {
    const kit = require(file);
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
  const pats = [];
  let hasPat = false;
  let onlyMatching = false;
  let opts = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!opts) { pos.push(a); continue; }
    if (a === '--') { opts = false; continue; }
    if (/^--(quiet|silent|count|files-with(out)?-match(es)?)$/.test(a)) return null;
    if (/^--regexp=/.test(a)) { hasPat = true; pats.push(a.slice(9)); continue; }
    if (a === '--regexp') { hasPat = true; pats.push(args[i + 1]); i++; continue; }
    if (a === '--only-matching') { onlyMatching = true; continue; }
    if (GREP_OPT_VAL.test(a)) { i++; continue; }
    if (a.startsWith('--')) continue;
    if (!a.startsWith('-')) { pos.push(a); continue; }
    const letters = a.slice(1);
    for (let k = 0; k < letters.length; k++) {
      const ch = letters[k];
      if ('qclL'.includes(ch)) return null;
      if (ch === 'o') onlyMatching = true;
      if (ch === 'e') { hasPat = true; pats.push(k === letters.length - 1 ? args[i + 1] : letters.slice(k + 1)); if (k === letters.length - 1) i++; break; }
      if ('mABCdf'.includes(ch)) { if (ch === 'f') hasPat = true; if (k === letters.length - 1) i++; break; }
    }
  }
  if (!hasPat && pos.length) pats.push(pos[0]);
  // `grep -o` of key names prints `KEY=` and nothing after it.
  if (onlyMatching && pats.length && pats.every((pt) => KEY_NAME_PATTERN.test(String(pt)))) return null;
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

// A word without its `$(…)` and backtick substitutions: their output is printed, not the variables
// passed to them; the commands inside are judged on their own (`commands` lists them).
// Arithmetic `$((…))` stays: it prints the value it computes.
function dropSubstitutions(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    if (word[i] === '$' && word[i + 1] === '(' && word[i + 2] !== '(') i = closeParen(word, i + 1);
    else if (word[i] === '`') i = closeTick(word, i);
    else out += word[i];
  }
  return out;
}

// The directory a `cd`/`pushd` moves to from `dir`, or null when unknown. A target the shell would
// expand (`-`, `$D`, a glob) resolves to a path that does not exist, so its dotenv stays unreadable.
function cdTarget(dir, args) {
  const target = args.filter((a) => a !== '--' && a !== '-P' && a !== '-L');
  if (dir === null || target.length !== 1) return null;
  return path.resolve(dir, target[0].replace(/^~(?=\/|$)/, os.homedir()));
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
    // `${X:+text}` prints only text when X is set; `${X:-text}` prints X's value, so it still counts.
    const names = args.flatMap((a) => [...dropSubstitutions(a).replace(/\$\{[A-Za-z_]\w*:?\+[^$}]*\}/g, '').matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1]));
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

// A loop's header word: the first word that is no grouping or keyword (`do for …`, `then while …`).
const loopHead = (w) => w.find((x) => !/^(\{|\(|!|time|do|then|else|elif)$/.test(x)) || '';

function printedSecrets(command, isSecret, cwd) {
  const leaked = [];
  const sourced = [];
  // Shell trace prints each value as the file sets it or as a later command uses it, so it counts in
  // any order; any other print counts only when it runs after the load: later in the command, or in a
  // loop around the load (its next round runs after the load).
  let trace = false;
  const prints = [];
  const loops = [];
  // The directory a command runs in: the last `cd`/`pushd` (`cdTarget`) in its own shell or one
  // enclosing it (a `cd` inside `(…)` or `$(…)` ends there); after `popd`, `env -C`/`sudo -D` or a
  // `cd` with no single target it is unknown (null), so a relative file loaded there cannot be read.
  const start = path.resolve(cwd || process.cwd());
  const cds = [];
  const inScope = (scope, of) => scope === of || String(scope).startsWith(`${of}.`);
  const dirIn = (scope) => cds.reduce((d, cd) => (inScope(scope, cd.scope) ? cd.dir : d), start);
  const aliases = {}; // `X=$A_KEY`: X carries A_KEY; `X=$(curl $A_KEY)` holds curl's output
  const refs = (w) => [...dropSubstitutions(String(w)).matchAll(/\$\{?([A-Za-z_]\w*)/g)].map((m) => m[1]);
  commands(command).forEach((words, k) => {
    if (/^(for|while|until)$/.test(loopHead(words))) loops.push({ start: k, end: Infinity });
    if (/^done(?:$|[<>|&;)])/.test(words[0] || '')) {
      const last = [...loops].reverse().find((l) => l.end === Infinity);
      if (last) last.end = k;
    }
    const set = assignments(words);
    for (const [name, value] of set || []) aliases[name] = refs(value).flatMap((r) => [r, ...(aliases[r] || [])]);
    const { argv, stdinFiles } = splitRedirects(words);
    const prog = program(argv);
    const name = (prog[0] || '').replace(/^.*[\\/]/, '').toLowerCase();
    const args = prog.slice(1);
    if (name === 'cd' || name === 'pushd') cds.push({ scope: words.scope, dir: cdTarget(dirIn(words.scope), args) });
    else if (name === 'popd' || prog.chdir !== undefined) cds.push({ scope: words.scope, dir: null });
    if ((name === 'source' || name === '.') && args[0] && isSecret(args[0])) {
      sourced.push({ file: args[0], dir: dirIn(words.scope), k, around: loops.filter((l) => l.end === Infinity) });
    }
    const files = printerFiles(name, args);
    if (files !== null) {
      for (const f of [...files, ...stdinFiles]) if (isSecret(f)) leaked.push(f);
    }
    const vars = printsVars(argv, prog);
    if (name === 'set' && setsTrace(args)) trace = true;
    if (vars.all || vars.names.length) prints.push({ k, all: vars.all, names: vars.names });
  });
  for (const { file, dir: from, k, around } of sourced) {
    const after = prints.filter((p) => p.k > k || around.some((l) => p.k >= l.start && p.k <= l.end));
    const named = after.flatMap((p) => p.names);
    const keys = from === null && !path.isAbsolute(file.replace(/^~(?=\/)/, os.homedir())) ? null : keysOf(file, from || cwd);
    const carries = (n) => [n, ...(aliases[n] || [])];
    if (trace || after.some((p) => p.all) || named.some((n) => keys === null || carries(n).some((key) => keys.has(key)))) leaked.push(file);
  }
  return [...new Set(leaked)];
}

// The answers the user picked or typed in AskUserQuestion boxes (`"<question>"="<answer>"` in the
// tool result), never the questions Claude wrote.
function askAnswers(transcript) {
  let raw = '';
  try { raw = require('fs').readFileSync(transcript, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('tool_result')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
      if (b?.type !== 'tool_result') continue;
      const text = (typeof b.content === 'string' ? b.content : (b.content || []).map((x) => x?.text || '').join('')).trim();
      if (!ASK_ANSWER.test(text)) continue;
      for (const m of text.matchAll(/"="((?:[^"\\]|\\.)*)"/g)) out.push(m[1]);
    }
  }
  return out;
}
const typedOrPicked = (transcript) => [...require('./lib/user-intent.cjs').userTexts(transcript), ...askAnswers(transcript)];

function approved(command, transcript, userTexts) {
  const m = APPROVAL.exec(command || '');
  if (!m || !transcript) return false;
  const quote = norm(m[1]);
  return userTexts(transcript).some((t) => norm(t).includes(quote));
}

// The verdict on one call: { deny, paths, fallback, uninspectable, onlyDotenv, reason }.
function judge(data, { checker = loadChecker(), userTexts = typedOrPicked } = {}) {
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
      'until it loads again, a read he approves carries `# secret-ok: "<his exact words, or the answer he picked in an ask>"`.'
    );
  }
  const what = access.uninspectable ? access.reason || 'a command this guard cannot read' : access.paths.join(', ');
  return (
    `secret-file-guard: this ${tool} call would print a secret file into the conversation (${what}). ` +
    (access.onlyDotenv
      ? 'Use the file without printing it: `set -a; . ./.env; set +a; <command>`, `--env-file=<file>`, ' +
        'or pass its path to a script that parses it without printing (`grep -q`/`grep -c \'^KEY=\' <file>` to check a key is set, ' +
        '`grep -o \'^[A-Z_][A-Z0-9_]*=\' <file>` to list its keys). '
      : 'Keys and credentials stay unprinted; pass the path to a command or script that uses it without printing. ') +
    'If Viet must see a value, ask him; once he agrees, rerun the Bash command with the comment ' +
    '`# secret-ok: "<his exact words, or the answer he picked in an ask, 8+ characters>"`, and print only what he asked for.'
  );
}

// What a simple command prints that can hold a secret passed on a command line or in the environment
// (`docker inspect` of the config, `ps -o args`, `/proc/<pid>/cmdline`), or null.
const INSPECT_FIELDS = /\.Config\.(Cmd|Env|Entrypoint)\b|\.Args\b|\.Config\s*\}\}|\{\{\s*json\s+\.\s*\}\}|\{\{\s*\.\s*\}\}/;
// `{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}` prints the keys only.
const ENV_KEYS = /\{\{\s*range\s+\.Config\.Env\s*\}\}[\s\S]*?\{\{\s*end\s*\}\}/g;
const KEY_ONLY = /index\s*\(\s*split\s+\.\s+"="\s*\)\s*0/;
// A stage that prints no value of what it reads: a hash, a count, or jq masking values as `<val>`.
const MASKS = (w) => /^(sha256sum|shasum|sha1sum|md5sum|md5|b2sum|wc)$/.test(w[0] || '') || (w[0] === 'jq' && w.some((a) => a.includes('<val>')));
const DOCKER_VALUE = /^(-H|--host|-c|--context|--config|-l|--log-level)$/;
function printsCommandLine(words) {
  const w = program(words);
  if (w[0] === 'docker') {
    let i = 1;
    while (i < w.length && w[i].startsWith('-')) i += DOCKER_VALUE.test(w[i]) ? 2 : 1;
    const at = w[i] === 'inspect' ? i : /^(container|image)$/.test(w[i] || '') && w[i + 1] === 'inspect' ? i + 1 : -1;
    if (at < 0) return null;
    const rest = w.slice(at + 1);
    const k = rest.findIndex((a) => a === '--format' || a === '-f' || /^--format=/.test(a) || /^-f./.test(a));
    if (k < 0) return 'docker inspect (no --format)';
    const a = rest[k];
    const fmt = a.startsWith('--format=') ? a.slice(9) : a === '--format' || a === '-f' ? rest[k + 1] || '' : a.slice(2);
    const shown = fmt.replace(ENV_KEYS, (m) => (KEY_ONLY.test(m) ? '' : m));
    return INSPECT_FIELDS.test(shown) ? `docker inspect --format '${fmt.slice(0, 60)}'` : null;
  }
  if (w[0] === 'ps') {
    for (let i = 1; i < w.length; i++) {
      const m = /^-[a-zA-Z]*[oO]$/.test(w[i]) ? w[i + 1] : (/^-[a-zA-Z]*[oO](.+)$/.exec(w[i]) || [])[1];
      if (m && /(^|,)(args|command|cmd)(=|,|$)/.test(m)) return `ps -o ${m}`;
    }
    return null;
  }
  return w.slice(1).find((a) => /^\/proc\/[^/\s]+\/(cmdline|environ)$/.test(a)) || null;
}
function inspectionLeak(command, cwd) {
  const scan = (text, depth) => {
    const all = commands(text);
    for (let k = 0; k < all.length; k++) {
      const words = all[k];
      // Piped into a hash, a count or a masking jq, nothing it prints reaches the transcript.
      const hit = printsCommandLine(words);
      if (hit && !pipedInto(all, k).map(program).some(MASKS)) return hit;
      const inner = innerScript(program(words));
      if (inner !== null && depth < 3) {
        const deeper = scan(inner, depth + 1);
        if (deeper) return deeper;
      }
    }
    return null;
  };
  for (const text of [command, ...scriptsRun(command, cwd || process.cwd()).map((s) => s.text)]) {
    const hit = scan(text, 0);
    if (hit) return hit;
  }
  return null;
}
const inspectionNote = (hit) =>
  `secret-file-guard: \`${hit}\` can print a secret passed on a command line or in the environment ` +
  '(`--requirepass <value>`, a `Config.Env` entry), and a filter by length misses short ones. Print names only: ' +
  'flag names (`docker inspect <c> --format \'{{json .Config.Cmd}}\' | jq -c \'map(if startswith("-") then . else "<val>" end)\'`), ' +
  'env keys (`--format \'{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}\'`), or a hash (`| sha256sum | cut -c1-12`).';

module.exports = { decide, judge, printedSecrets, inspectionLeak, inspectionNote, loadChecker, askAnswers };
if (require.main !== module) return;

try {
  const data = JSON.parse(require('fs').readFileSync(0, 'utf8') || '{}');
  const why = decide(data);
  if (why) {
    process.stderr.write(`${why}\n`);
    process.exit(2);
  }
  const command = data.tool_name === 'Bash' ? String((data.tool_input || {}).command || '') : '';
  const hit = command && inspectionLeak(command, data.cwd);
  if (hit) {
    const { firstTime, again } = require('./lib/block-once.cjs');
    if (firstTime(data.session_id, 'secret-file-guard', command)) {
      process.stderr.write(`${inspectionNote(hit)}${again(data.session_id)}\n`);
      process.exit(2);
    }
  }
} catch {
  // fail open
}
process.exit(0);

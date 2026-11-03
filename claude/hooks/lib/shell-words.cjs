/**
 * shell-words.cjs - split a Bash command into simple commands, each a list of words, the way a
 * shell would read them closely enough for a guard: quotes (`'…'`, `"…"`, `$'…'`) kept together
 * (and removed), `\`+newline joined, separators outside quotes (`;` `&&` `||` `|` `&` newline)
 * end a command; `&` inside a redirection (`2>&1`) does not.
 * A command substitution (`$(…)`, backticks, also inside `"…"`) or a subshell `(…)` is read up to
 * its own closing mark and yields its commands too; the outer word keeps the substitution's text.
 * Each command carries `.scope`, a dotted path of the subshells it runs in (`0`, `0.2`…): `(…)`,
 * `$(…)`, backticks, each element of a pipeline and a background job get their own, so a guard
 * can tell that a `cd` there does not reach later commands. `.braces` marks a command with an
 * unquoted brace expansion (`{a,b}`), whose words the shell rewrites. Nesting deeper than
 * MAX_DEPTH is not read: the result gets `.incomplete`, and a guard should treat it as unknown.
 * Heredoc bodies are dropped unless the heredoc feeds a shell (`bash <<EOF`), whose body runs; an
 * unquoted heredoc keeps the substitutions in its body, which run.
 * Expansions (`$URL`) are left as written: a guard cannot see their value.
 */
const HEREDOC = /<<-?[ \t]*(['"]?)([^\s'"<>;&|()]+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const MAX_DEPTH = 64;

// Index of the mark closing the `(`, `"` or backtick at `open`, read iteratively: quotes,
// `$'…'`, comments and nested substitutions inside are skipped whole.
function closeAt(s, open) {
  const stack = [s[open]];
  for (let i = open + 1; i < s.length; i++) {
    const top = stack[stack.length - 1];
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (top === '`') {
      if (c === '`') stack.pop();
    } else if (top === '"') {
      if (c === '"') stack.pop();
      else if (c === '$' && s[i + 1] === '(') { stack.push('('); i++; }
      else if (c === '`') stack.push('`');
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      i = j < 0 ? s.length : j;
    } else if (c === '$' && s[i + 1] === "'") {
      for (i += 2; i < s.length && s[i] !== "'"; i++) if (s[i] === '\\') i++;
    } else if (c === '#' && (i === 0 || /[\s;&|(]/.test(s[i - 1]))) {
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
    } else if (c === '"' || c === '`' || c === '(') {
      stack.push(c);
    } else if (c === ')') {
      stack.pop();
    }
    if (!stack.length) return i;
  }
  return s.length;
}

// The substitutions in a text where only `$(…)` and backticks are live (an unquoted heredoc body).
function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '(') { const j = closeAt(text, i + 1); out.push(text.slice(i, j + 1)); i = j; }
    else if (text[i] === '`') { const j = closeAt(text, i); out.push(text.slice(i, j + 1)); i = j; }
  }
  return out;
}

function dropHeredocs(cmd) {
  return cmd.replace(HEREDOC, (m, quote, _tag, rest, offset) => {
    const before = cmd.slice(Math.max(0, cmd.lastIndexOf('\n', offset - 1) + 1), offset);
    const header = m.slice(0, m.indexOf('\n'));
    const feedsShell = /(^|[\s;&|(])(\S*\/)?(ba|z|da)?sh(\s+-\S+)*\s*$/.test(before) ||
      /\|\s*(\S*\/)?(ba|z|da)?sh\b/.test(header);
    if (feedsShell) return `<<heredoc-shell${rest}${m.slice(m.indexOf('\n'))}`;
    const body = m.slice(m.indexOf('\n') + 1, m.lastIndexOf('\n'));
    const live = quote ? [] : substitutions(body);
    return `<<heredoc${rest}${live.map((s) => `\n${s}`).join('')}`;
  });
}

const ANSI = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v' };
const BRACES = /\{[^{}\s]*(,|\.\.)[^{}\s]*\}/;

function commands(command) {
  const out = [];
  let next = 0;
  parse(dropHeredocs(String(command || '').replace(/\\\r?\n/g, ' ')), '0', out, () => ++next, 0);
  return out;
}

function parse(cmd, scope, out, id, depth) {
  let words = [];
  let word = null;
  let bare = ''; // the word's unquoted text, where brace expansion happens
  let braces = false;
  let piped = false;
  const add = (text, unquoted) => { word = (word || '') + text; if (unquoted) bare += text; };
  const endWord = () => {
    if (word !== null) words.push(word);
    if (BRACES.test(bare)) braces = true;
    word = null;
    bare = '';
  };
  const endCmd = (own) => {
    endWord();
    if (words.length) {
      words.scope = own || piped ? `${scope}.${id()}` : scope;
      if (braces) words.braces = true;
      out.push(words);
    }
    words = [];
    braces = false;
  };
  const sub = (text) => {
    if (depth >= MAX_DEPTH) { out.incomplete = true; return; }
    parse(text, `${scope}.${id()}`, out, id, depth + 1);
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      add(cmd.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      const end = closeAt(cmd, i);
      let s = '';
      for (let j = i + 1; j < end; j++) {
        if (cmd[j] === '\\' && /[$`"\\]/.test(cmd[j + 1] || '')) s += cmd[++j];
        else if (cmd[j] === '$' && cmd[j + 1] === '(') { const k = closeAt(cmd, j + 1); sub(cmd.slice(j + 2, k)); s += cmd.slice(j, k + 1); j = k; }
        else if (cmd[j] === '`') { const k = closeAt(cmd, j); sub(cmd.slice(j + 1, k)); s += cmd.slice(j, k + 1); j = k; }
        else s += cmd[j];
      }
      add(s);
      i = end;
    } else if (c === '$' && cmd[i + 1] === "'") {
      // ANSI-C quoting: `\'` does not end it; common escapes are decoded.
      let j = i + 2;
      let s = '';
      for (; j < cmd.length && cmd[j] !== "'"; j++) {
        if (cmd[j] !== '\\' || j + 1 >= cmd.length) { s += cmd[j]; continue; }
        const e = cmd[++j];
        const hex = e === 'x' && /^[0-9a-fA-F]{1,2}/.exec(cmd.slice(j + 1, j + 3));
        if (hex) { s += String.fromCharCode(parseInt(hex[0], 16)); j += hex[0].length; } else s += ANSI[e] || e;
      }
      add(s);
      i = j;
    } else if (c === '\\' && i + 1 < cmd.length) {
      add(cmd[++i]);
    } else if (c === '#' && word === null) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
    } else if (c === '$' && cmd[i + 1] === '(') {
      const k = closeAt(cmd, i + 1);
      sub(cmd.slice(i + 2, k));
      add(cmd.slice(i, k + 1));
      i = k;
    } else if (c === '`') {
      const k = closeAt(cmd, i);
      sub(cmd.slice(i + 1, k));
      add(cmd.slice(i, k + 1));
      i = k;
    } else if (c === '(' && (word === null || /^[<>]$/.test(word))) {
      // A subshell, or process substitution `<(…)`/`>(…)`: both run in their own shell.
      if (word !== null) word = null;
      endCmd();
      const k = closeAt(cmd, i);
      sub(cmd.slice(i + 1, k));
      i = k;
    } else if (c === '&' && (/[<>]/.test(cmd[i - 1] || '') || cmd[i + 1] === '>')) {
      add(c, true); // a redirection: `2>&1`, `&>file`
    } else if ((c === '&' || c === '|') && cmd[i + 1] === c) {
      endCmd();
      piped = false;
      i++;
    } else if (c === '|') {
      endCmd(true);
      piped = true;
      if (cmd[i + 1] === '&') i++;
    } else if (c === '&') {
      endCmd(true);
      piped = false;
    } else if (c === ';' || c === '\n' || c === ')' || c === '(') {
      endCmd();
      piped = false;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      add(c, true);
    }
  }
  endCmd();
}

// The words from the command name on: drops shell keywords (`then`, `do`, `{`, `!`…), `VAR=x`
// assignments, wrappers (`sudo`, `env`, `xargs`, `timeout`, `time`…) with their flags (short or
// long, value attached or not), and a path before the name (`/usr/bin/open` → `open`). A
// wrapper that changes directory (`env -C`, `sudo -D`, `--chdir`) sets `.chdir` on the result;
// `env -S '<s>'` splits its string into words as env does.
const KEYWORD = /^(then|do|else|elif|if|while|until|\{|\}|!)$/;
const WRAPPERS = {
  sudo: { short: 'ugCDhprtURT', long: ['user', 'group', 'chdir', 'host', 'prompt', 'role', 'type', 'other-user', 'close-from', 'command-timeout'], chdir: ['-D', '--chdir'] },
  env: { short: 'uCSP', long: ['unset', 'chdir', 'split-string'], chdir: ['-C', '--chdir'], split: ['-S', '--split-string'] },
  xargs: { short: 'ILnPJsREda', long: ['max-args', 'max-procs', 'max-chars', 'max-lines', 'replace', 'delimiter', 'arg-file', 'eof'] },
  nice: { short: 'n', long: ['adjustment'] },
  timeout: { short: 'sk', long: ['signal', 'kill-after'], positional: 1 },
  caffeinate: { short: 'tw', long: [] },
  exec: { short: 'a', long: [] },
  command: { short: '', long: [] },
  nohup: { short: '', long: [] },
  time: { short: '', long: [] },
};
function program(words) {
  let i = 0;
  let chdir;
  let split = null;
  while (i < words.length) {
    if (KEYWORD.test(words[i]) || /^\w+=/.test(words[i])) { i++; continue; }
    const w = WRAPPERS[words[i]];
    if (!w || !Object.hasOwn(WRAPPERS, words[i])) break;
    i++;
    while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
      const f = words[i];
      let name;
      let value;
      let took = 1;
      const long = /^--([^=]+)(?:=(.*))?$/.exec(f);
      if (long) {
        name = `--${long[1]}`;
        if (long[2] !== undefined) value = long[2];
        else if (w.long.includes(long[1])) { value = words[i + 1]; took = 2; }
      } else if (f.length > 1 && w.short.includes(f[1])) {
        name = f.slice(0, 2);
        if (f.length > 2) value = f.slice(2);
        else { value = words[i + 1]; took = 2; }
      }
      if (value !== undefined && w.chdir && w.chdir.includes(name)) chdir = value;
      if (value !== undefined && w.split && w.split.includes(name)) split = value;
      i += took;
    }
    if (words[i] === '--') i++;
    i += w.positional || 0;
  }
  let rest = words.slice(i);
  if (split !== null) rest = [...(split.match(/\S+/g) || []), ...rest];
  if (rest.length && !/[$`]/.test(rest[0])) rest[0] = rest[0].replace(/^.*\//, '');
  if (chdir !== undefined) rest.chdir = chdir;
  return rest;
}

const SHELL = /^(ba|z|da|k)?sh$/;

// The script a command runs as shell code: `{ script, same }`, `same` when it runs in this shell
// (`eval`, `source`-less), else in a new one (`bash -c '<s>'`, `bash <<< '<s>'`); `{ script: null }`
// for a shell reading a script this hook cannot see (stdin from a pipe); null for none. `ssh host
// '<s>'` is not one: it runs elsewhere.
function innerScript(words) {
  if (words[0] === 'eval') return { script: words.slice(1).join(' '), same: true };
  if (!SHELL.test(words[0] || '')) return null;
  const c = words.findIndex((w, k) => k > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
  if (c > 0) return { script: words[c + 1] ?? '', same: false };
  const here = words.indexOf('<<<');
  if (here > 0) return { script: words[here + 1] ?? '', same: false };
  if (words.includes('<<heredoc-shell')) return null; // its body was kept as commands
  const file = words.slice(1).find((w) => !w.startsWith('-') && !/^[<>]/.test(w));
  return file ? null : { script: null, same: false };
}

module.exports = { commands, program, innerScript, dropHeredocs, MAX_DEPTH };

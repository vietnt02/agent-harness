/**
 * shell-words.cjs - split a Bash command into simple commands, each a list of words, the way a
 * shell would read them closely enough for a guard: quotes (`'…'`, `"…"`, `$'…'`) kept together
 * (and removed), `\`+newline joined, separators outside quotes (`;` `&` `|` newline) end a command.
 * A command substitution (`$(…)`, backticks, also inside `"…"`) or a subshell `(…)` is read up to
 * its own closing mark and yields its commands too; the outer word keeps the substitution's text.
 * Each command carries `.scope`, a dotted path of the subshells it runs in (`0`, `0.2`…), so a
 * guard can tell that a `cd` inside `(…)` or `$(…)` ends with it.
 * Heredoc bodies are dropped unless the heredoc feeds a shell (`bash <<EOF`), whose body runs; an
 * unquoted heredoc keeps the substitutions in its body, which run.
 * Expansions (`$URL`) are left as written; `assignments` and `expandVars` let a guard follow a
 * variable the same command set to a literal (`WT=/path` … `cd $WT`).
 */
const HEREDOC = /<<-?[ \t]*(['"]?)([^\s'"<>;&|()]+)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

// Index of the `)` closing the `(` at `open`, skipping quotes and nested parentheses.
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") { const j = s.indexOf("'", i + 1); i = j < 0 ? s.length : j; }
    else if (c === '"') { i = closeQuote(s, i); }
    else if (c === '`') { const j = closeTick(s, i); i = j; }
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

// Index of the `"` closing the one at `open`; `$(…)` and backticks inside are skipped whole.
function closeQuote(s, open) {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '$' && s[i + 1] === '(') i = closeParen(s, i + 1);
    else if (s[i] === '`') i = closeTick(s, i);
    else if (s[i] === '"') return i;
  }
  return s.length;
}

function closeTick(s, open) {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  return s.length;
}

// The substitutions in a text where only `$(…)` and backticks are live (an unquoted heredoc body).
function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '$' && text[i + 1] === '(') { const j = closeParen(text, i + 1); out.push(text.slice(i, j + 1)); i = j; }
    else if (text[i] === '`') { const j = closeTick(text, i); out.push(text.slice(i, j + 1)); i = j; }
  }
  return out;
}

function dropHeredocs(cmd) {
  return cmd.replace(HEREDOC, (m, quote, _tag, rest, offset) => {
    const before = cmd.slice(Math.max(0, cmd.lastIndexOf('\n', offset - 1) + 1), offset);
    const header = m.slice(0, m.indexOf('\n'));
    const feedsShell = /(^|[\s;&|(])(\S*\/)?(ba|z|da)?sh(\s+-\S+)*\s*$/.test(before) ||
      /\|\s*(\S*\/)?(ba|z|da)?sh\b/.test(header);
    if (feedsShell) return m.slice(m.indexOf('\n'));
    const body = m.slice(m.indexOf('\n') + 1, m.lastIndexOf('\n'));
    const live = quote ? [] : substitutions(body);
    return `<<heredoc${rest}${live.map((s) => `\n${s}`).join('')}`;
  });
}

const ANSI = { n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v' };

function commands(command) {
  const out = [];
  let next = 0;
  parse(dropHeredocs(String(command || '').replace(/\\\r?\n/g, ' ')), '0', out, () => ++next);
  return out;
}

function parse(cmd, scope, out, id) {
  let words = [];
  let word = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCmd = () => {
    endWord();
    if (words.length) { words.scope = scope; out.push(words); }
    words = [];
  };
  const sub = (text) => parse(text, `${scope}.${id()}`, out, id);
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      word = (word || '') + cmd.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      const end = closeQuote(cmd, i);
      let s = '';
      for (let j = i + 1; j < end; j++) {
        if (cmd[j] === '\\' && /[$`"\\]/.test(cmd[j + 1] || '')) s += cmd[++j];
        else if (cmd[j] === '$' && cmd[j + 1] === '(') { const k = closeParen(cmd, j + 1); sub(cmd.slice(j + 2, k)); s += cmd.slice(j, k + 1); j = k; }
        else if (cmd[j] === '`') { const k = closeTick(cmd, j); sub(cmd.slice(j + 1, k)); s += cmd.slice(j, k + 1); j = k; }
        else s += cmd[j];
      }
      word = (word || '') + s;
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
      word = (word || '') + s;
      i = j;
    } else if (c === '\\' && i + 1 < cmd.length) {
      word = (word || '') + cmd[++i];
    } else if (c === '#' && word === null) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
    } else if (c === '$' && cmd[i + 1] === '(') {
      const k = closeParen(cmd, i + 1);
      sub(cmd.slice(i + 2, k));
      word = (word || '') + cmd.slice(i, k + 1);
      i = k;
    } else if (c === '`') {
      const k = closeTick(cmd, i);
      sub(cmd.slice(i + 1, k));
      word = (word || '') + cmd.slice(i, k + 1);
      i = k;
    } else if (c === '(' && word === null) {
      endCmd();
      const k = closeParen(cmd, i);
      sub(cmd.slice(i + 1, k));
      i = k;
    } else if (/[;&|()\n]/.test(c)) {
      endCmd();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word || '') + c;
    }
  }
  endCmd();
}

// The words from the command name on: drops shell keywords (`then`, `do`, `{`, `!`…), `VAR=x`
// assignments, wrappers (`sudo`, `env`, `xargs`, `timeout`…) with their flags (`sudo -u me`), and
// a path before the name (`/usr/bin/open` → `open`). A wrapper that changes directory
// (`env -C <dir>`, `sudo -D <dir>`) sets `.chdir` on the result.
const KEYWORD = /^(then|do|else|elif|if|while|until|\{|\}|!|time)$/;
const WRAPPER_VALUE = {
  sudo: /^-(u|g|C|D|h|p|r|t|U|R|T)$/,
  env: /^-(u|C|S|P)$/,
  xargs: /^-(I|L|n|P|J|s|R|E|d|a)$/,
  nice: /^-n$/,
  timeout: /^-(s|k)$/,
  caffeinate: /^-(t|w)$/,
  exec: /^-a$/,
  command: null,
  nohup: null,
  time: null,
};
function program(words) {
  let i = 0;
  let chdir;
  while (i < words.length) {
    if (KEYWORD.test(words[i]) || /^\w+=/.test(words[i])) { i++; continue; }
    const w = words[i];
    if (!Object.hasOwn(WRAPPER_VALUE, w)) break;
    i++;
    while (i < words.length && words[i].startsWith('-') && words[i] !== '--') {
      const takes = WRAPPER_VALUE[w] && WRAPPER_VALUE[w].test(words[i]);
      if (takes && ((w === 'env' && words[i] === '-C') || (w === 'sudo' && words[i] === '-D'))) chdir = words[i + 1];
      i += takes ? 2 : 1;
    }
    if (words[i] === '--') i++;
    if (w === 'timeout') i++; // its duration
  }
  const rest = words.slice(i);
  if (rest.length) rest[0] = rest[0].replace(/^.*\//, '');
  if (chdir !== undefined) rest.chdir = chdir;
  return rest;
}

// The script a command runs in this shell's place (`bash -c '<s>'`, `sh -lc '<s>'`, `eval <s>`),
// or null. `ssh host '<s>'` is not one: it runs elsewhere.
function innerScript(words) {
  if (words[0] === 'eval') return words.slice(1).join(' ');
  if (!/^(ba|z|da|k)?sh$/.test(words[0] || '')) return null;
  // `-c` counts only among the shell's own options, before its first operand (`sh x.sh -c y`
  // passes `-c` to x.sh); the script is that first operand, wherever `-c` stood among the options
  // (`-c -e '<s>'`). Each `o`/`O` in a short option and the long `--rcfile`, `--init-file`,
  // `--emulate` take the next word; `--` ends the options.
  let c = false;
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    if (w === '--') return c && k + 1 < words.length ? words[k + 1] : null;
    if (/^--(rcfile|init-file|emulate)$/.test(w)) { k++; continue; }
    if (/^--./.test(w)) continue;
    if (!/^[-+][a-zA-Z]+$/.test(w)) return c ? w : null;
    if (w[0] === '-' && w.includes('c')) c = true;
    k += (w.match(/[oO]/g) || []).length;
  }
  return null;
}

// The `NAME=value` pairs a command made only of assignments sets for the rest of its shell
// (`X=1 Y=2`, `export X=1`), else null: `X=1 git push` sets X for that command alone.
function assignments(words) {
  const rest = words[0] === 'export' ? words.slice(1) : words;
  if (!rest.length || !rest.every((w) => /^\w+=/.test(w))) return null;
  return rest.map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]);
}

// A word with `$NAME` / `${NAME}` taken from `vars` (name → literal), or null while it still holds
// an expansion whose value is unknown here (an unset name, `$(…)`, backticks, `${x:-…}`).
function expandVars(word, vars) {
  const out = word.replace(/\$(?:\{(\w+)\}|(\w+))/g, (m, a, b) => (Object.hasOwn(vars, a || b) ? vars[a || b] : m));
  return /[$`]/.test(out) ? null : out;
}

module.exports = { commands, program, innerScript, dropHeredocs, assignments, expandVars };

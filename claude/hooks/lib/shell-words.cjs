/**
 * shell-words.cjs - split a Bash command into simple commands, each a list of words, the way a
 * shell would read them closely enough for a guard: quotes (`'…'`, `"…"`, `$'…'`) kept together (and removed), `\`+newline
 * joined, separators outside quotes (`;` `&` `|` `(` `)` backtick, `$(`, newline) end a command.
 * Heredoc bodies are dropped unless the heredoc feeds a shell (`bash <<EOF`), whose body runs.
 * Expansions (`$URL`) are left as written: a guard cannot see their value.
 */
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;

function dropHeredocs(cmd) {
  return cmd.replace(HEREDOC, (m, _q, _tag, offset) => {
    const before = cmd.slice(Math.max(0, cmd.lastIndexOf('\n', offset - 1) + 1), offset);
    const header = m.slice(0, m.indexOf('\n'));
    const feedsShell = /(^|[\s;&|(])(\S*\/)?(ba|z|da)?sh(\s+-\S+)*\s*$/.test(before) ||
      /\|\s*(\S*\/)?(ba|z|da)?sh\b/.test(header);
    return feedsShell ? m.slice(m.indexOf('\n')) : '<<heredoc';
  });
}

function commands(command) {
  const cmd = dropHeredocs(String(command || '').replace(/\\\r?\n/g, ' '));
  const out = [];
  let words = [];
  let word = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      const end = j < 0 ? cmd.length : j;
      word = (word || '') + cmd.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let s = '';
      // `$(…)` and backticks still run inside double quotes, unless escaped (`\``).
      let sub = -1;
      while (j < cmd.length && cmd[j] !== '"') {
        if (cmd[j] === '\\' && j + 1 < cmd.length) j++;
        else if (sub < 0 && (cmd[j] === '`' || (cmd[j] === '$' && cmd[j + 1] === '('))) sub = s.length;
        s += cmd[j];
        j++;
      }
      word = (word || '') + s;
      if (sub >= 0) out.push(...commands(s.slice(sub)));
      i = j;
    } else if (c === '$' && cmd[i + 1] === "'") {
      // ANSI-C quoting: `\'` does not end it.
      let j = i + 2;
      let s = '';
      while (j < cmd.length && cmd[j] !== "'") { if (cmd[j] === '\\' && j + 1 < cmd.length) j++; s += cmd[j]; j++; }
      word = (word || '') + s;
      i = j;
    } else if (c === '\\' && i + 1 < cmd.length) {
      word = (word || '') + cmd[++i];
    } else if (c === '#' && word === null) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
    } else if (/[;&|()`\n]/.test(c)) {
      endCmd();
    } else if (c === '$' && cmd[i + 1] === '(') {
      endCmd();
      i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word || '') + c;
    }
  }
  endCmd();
  return out;
}

// The words from the command name on: drops shell keywords (`then`, `do`, `{`, `!`…), `VAR=x`
// assignments, wrappers (`sudo`, `env`, `xargs`, `nohup`…) with their flags (`sudo -u me`), and a
// path before the name (`/usr/bin/open` → `open`).
const KEYWORD = /^(then|do|else|elif|if|while|until|\{|\}|!|time)$/;
const WRAPPER = /^(sudo|env|command|exec|nohup|xargs|nice|caffeinate|time)$/;
const FLAG_WITH_VALUE = /^-(u|g|n|I|L|P|C)$/;
function program(words) {
  let i = 0;
  while (i < words.length) {
    if (KEYWORD.test(words[i]) || /^\w+=/.test(words[i])) { i++; continue; }
    if (!WRAPPER.test(words[i])) break;
    i++;
    while (i < words.length && words[i].startsWith('-')) i += FLAG_WITH_VALUE.test(words[i]) ? 2 : 1;
  }
  const rest = words.slice(i);
  if (rest.length) rest[0] = rest[0].replace(/^.*\//, '');
  return rest;
}

module.exports = { commands, program, dropHeredocs };

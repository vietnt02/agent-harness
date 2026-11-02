#!/usr/bin/env node
/**
 * worker-start-receipt.cjs - PostToolUse / PostToolUseFailure (Bash): after `orca orchestration
 * worker-start`, read the new dispatch back from Orca (`worker-show`), whatever the command filtered
 * out of its own output. Registered on both events: a call that exits non-zero (`ok:false`, a
 * `jq -e` check) fires PostToolUseFailure, with the output in `error`.
 * - failed or a lastError: print it with the lines of ~/.claude/skills/ntv-orca/ that mention it, so
 *   the guide is read before any guess or `**Cần bạn:**` (ntv-orca Nhóm D).
 * - otherwise: remind that a receipt is a claim; the worker's terminal shows whether it took the spec.
 * - no dispatch id, or Orca unreachable: say so, and how to read the run instead.
 * - an antigravity worker: every running Orca agy chat server (`agy_acp_server`) must find
 *   `$GEMINI_HOME/config` -> ~/.gemini/config, or it runs without the global AGENTS.md and skills.
 *   Orca picks GEMINI_HOME itself, so a new Orca version or account can move it silently.
 * The new dispatch is `.result.dispatchId` of the receipt: other ids in the output (a dispatch the
 * error names, `--retry-of`, a chained worker-list) are not it. Fails open on any error.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GUIDE = path.join(os.homedir(), '.claude', 'skills', 'ntv-orca');
const DISPATCH = /(?:^|[;&|({\n]\s*|\b(?:then|do)\s+)(?:\w+=\S*\s+)*orca\s+orchestration\s+worker-start\b/;
const HELP = /\bworker-start\b[^;&|\n]*\s(?:--help|-h)\b/;
const ID = /\b(term|ctx|task|run|wtr)_[0-9a-f-]+/g;
const MAX_IDS = 3;
const FALLBACK = 'đọc `orca orchestration worker-list --run <run> --json` (`workerState`) và ' +
  '`worker-show --dispatch <ctx> --json` (`.result.worker.lastError`) trước khi báo worker đang chạy.';

const AGY_CONFIG = path.join(os.homedir(), '.gemini', 'config');
const ANTIGRAVITY = /--agent[\s=]+["']?antigravity(?![\w-])/;

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Guide lines mentioning the error, table rows first, history log (events.md) left out. The error is
// cut at its ids (the guide writes them `term_…`): each piece of 12+ characters is tried, then the
// first 20 characters of the whole error.
function guideLines(error) {
  const pieces = error.split(ID).filter((p, i) => i % 2 === 0).map((p) => p.trim().replace(/[\s([{:,;.]+$/, '')).filter((p) => p.length >= 12);
  for (const key of [...pieces.map((p) => p.slice(0, 40)), error.slice(0, 20)]) {
    let out = '';
    try { out = run('grep', ['-rnF', '--include=*.md', '--exclude=events.md', '-e', key, GUIDE]); } catch (_) { continue; }
    const lines = out.split('\n').filter(Boolean).map((l) => l.replace(GUIDE + '/', 'ntv-orca/'));
    const row = (l) => /^[^:]+:\d+:\|/.test(l);
    if (lines.length) return [...lines.filter(row), ...lines.filter((l) => !row(l))].slice(0, 3).map((l) => l.slice(0, 260));
  }
  return [];
}

function describe(dispatch) {
  // Orca 1.4.246 prints a concise record; `--full` keeps `.result.worker`.
  const w = JSON.parse(run('orca', ['orchestration', 'worker-show', '--dispatch', dispatch, '--json', '--full'])).result.worker;
  const read = `\`orca orchestration worker-read --dispatch ${dispatch} --source auto\``;
  if (w.state !== 'failed' && !w.lastError) {
    return `${dispatch}: state=${w.state}. Receipt chưa chứng minh worker nhận việc: ${read} phải thấy agent đang làm spec ` +
      'trước khi báo "đang chờ".';
  }
  const head = `${dispatch}: state=${w.state}, stage=${w.stage}, lastError="${w.lastError || ''}". ` +
    `Trước hết đọc ${read} (agent đã nhận spec? đang chạy?).`;
  if (!w.lastError) return `${head} Không có lastError: đọc ${read} và bảng Nhóm D trước khi kết luận.`;
  const refs = guideLines(w.lastError);
  return refs.length
    ? `${head} Guide nhắc tới lỗi này, đọc các dòng sau trước mọi bước khác (kể cả trước khi hỏi user):\n${refs.map((r) => `    ${r}`).join('\n')}`
    : `${head} Guide không nhắc tới lỗi này: đọc ${read} trước khi kết luận; chưa tra xong thì không nhờ user.`;
}

// GEMINI_HOME of each running Orca agy chat server (`ps -E` prints its env after the argv; the value
// may hold spaces, so it runs to the next ` name=`, `_` and lower case included).
function acpHomes() {
  let pids = [];
  try { pids = run('pgrep', ['-f', 'agy_acp_server']).split('\n').filter(Boolean); } catch (_) { return []; }
  const homes = pids.map((pid) => {
    try { return /\sGEMINI_HOME=(.+?)(?=\s[A-Za-z_][A-Za-z0-9_]*=|$)/.exec(run('ps', ['-E', '-o', 'command=', '-p', pid]))?.[1]; } catch (_) { return null; }
  });
  return [...new Set(homes.filter(Boolean))];
}

// One line per agy chat home whose `config` does not resolve to ~/.gemini/config.
function agyConfigLines(homes = acpHomes(), target = AGY_CONFIG) {
  let want;
  try { want = fs.realpathSync(target); } catch (_) { return []; }
  return homes.filter((h) => { try { return fs.realpathSync(path.join(h, 'config')) !== want; } catch (_) { return true; } })
    .map((h) => `agy chat chạy với GEMINI_HOME="${h}" mà "${h}/config" không trỏ về ${target}: worker và phiên chat ` +
      `agy chạy thiếu AGENTS.md toàn cục và skills. "${h}/config" là thư mục thật thì chuyển nó đi trước; rồi ` +
      `\`ln -sfn ${target} '${h}/config'\` (gỡ: \`rm '${h}/config'\`).`);
}

// One line when the agy versions installed now (CLI on PATH, Orca's chat runtimes) differ from the ones
// ~/.gemini/config/bridge-fixtures last passed on: a new version can change the hook payload.
function agyVersionLines(stampFile = path.join(os.homedir(), '.gemini', 'config', 'bridge-fixtures', 'tested-versions.json'),
  runtimesDir = path.join(os.homedir(), 'Library', 'Application Support', 'orca', 'agent-runtimes', 'antigravity'),
  cli = (() => { try { return run('agy', ['--version']); } catch (_) { return ''; } })()) {
  let tested;
  try { tested = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch (_) { tested = null; }
  if (!tested || typeof tested !== 'object' || !Array.isArray(tested.runtimes)) tested = { cli: '', runtimes: [] };
  let runtimes = [];
  try { runtimes = fs.readdirSync(runtimesDir).filter((d) => !d.startsWith('.')).sort(); } catch (_) { runtimes = []; }
  const same = tested.cli === cli && JSON.stringify(tested.runtimes || []) === JSON.stringify(runtimes);
  return same ? [] : [`agy đổi bản so với lần fixture bridge PASS (CLI ${tested.cli || '?'} → ${cli || '?'}, runtime chat ` +
    `${(tested.runtimes || []).join(',') || '?'} → ${runtimes.join(',') || '?'}): thu payload mới và so khoá với ` +
    '`~/.gemini/config/bridge-fixtures/payloads.json`, rồi `node ~/.gemini/config/bridge-fixtures/run.cjs` ' +
    '(đầu file run.cjs nói cách thu); tới lúc đó guard của agy có thể bỏ sót mà không báo.'];
}

// The receipts in the output: `.result.dispatchId` of each JSON block, else the ids of a filtered one
// (never from a chained worker-list, whose dispatches are old ones), and the error message of an
// `ok:false` receipt.
function receipts(output, max = MAX_IDS) {
  const ids = [];
  const errors = [];
  const blocks = [...(output.match(/^\{[\s\S]*?^\}/gm) || []), ...output.split('\n').filter((l) => /^\{.*\}\s*$/.test(l))];
  for (const block of blocks) {
    try {
      const r = JSON.parse(block);
      if (r.result?.dispatchId) ids.push(r.result.dispatchId);
      if (r.ok === false && r.error?.message) errors.push(r.error.message);
    } catch (_) { /* not a receipt */ }
  }
  // A filtered receipt: `"dispatch":"ctx_…"` fields, or bare `ctx_…` lines (`jq -r .result.dispatchId`).
  if (!ids.length && !/"workers"\s*:/.test(output)) {
    for (const m of output.matchAll(/"dispatch(?:Id)?"\s*:\s*"(ctx_[0-9a-f]+)"/g)) ids.push(m[1]);
    for (const m of output.matchAll(/^(ctx_[0-9a-f]+)\s*$/gm)) ids.push(m[1]);
  }
  return { ids: [...new Set(ids)].slice(0, max), errors: [...new Set(errors)] };
}

module.exports = { DISPATCH, HELP, receipts, agyConfigLines, agyVersionLines };
if (require.main !== module) return;

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const { hook_event_name: event, tool_name: tool, tool_input: input = {}, tool_response: resp = {}, error } = JSON.parse(raw);
    const command = input.command || '';
    if (tool !== 'Bash' || !DISPATCH.test(command) || HELP.test(command)) process.exit(0);
    const output = event === 'PostToolUseFailure'
      ? String(error || '')
      : typeof resp === 'string' ? resp : `${resp.stdout || ''}\n${resp.stderr || ''}`;
    const { ids, errors } = receipts(output);
    let lines = ids.map((d) => { try { return describe(d); } catch (_) { return null; } }).filter(Boolean);
    if (!ids.length) lines = [`Output không có dispatchId của receipt (bị lọc, hay lệnh lỗi trước khi giao): ${FALLBACK}`];
    else if (!lines.length) lines = [`Không đọc được ${ids.join(', ')} từ Orca: ${FALLBACK}`];
    if (ANTIGRAVITY.test(command)) lines.push(...agyConfigLines(), ...agyVersionLines());
    for (const message of errors) {
      const refs = guideLines(message);
      lines.push(`ok:false "${message.slice(0, 200)}"` + (refs.length
        ? `. Guide nhắc tới lỗi này, đọc trước mọi bước khác:\n${refs.map((r) => `    ${r}`).join('\n')}`
        : '. Guide không nhắc tới lỗi này.'));
    }
    const context = 'worker-start-receipt:\n' + lines.map((l) => `- ${l}`).join('\n');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event || 'PostToolUse', additionalContext: context } }));
  } catch (_) { /* fail-open */ }
  process.exit(0);
});

#!/usr/bin/env node
/**
 * claude-hook-bridge.cjs - Unified safety & quality hook bridge for Antigravity (agy).
 *
 * Usage in ~/.gemini/config/hooks.json:
 *   node ~/.gemini/config/claude-hook-bridge.cjs <PreInvocation|PreToolUse|PostToolUse|Stop>
 *
 * Behavior (Unified Mode):
 * - PreInvocation:
 *   - No longer injects ~/.claude/CLAUDE.md, every .md under ~/.claude/rules/, or session-notes.cjs
 *     (core instructions live in ~/.gemini/config/AGENTS.md).
 *   - Resets sub-repo context state on compaction (`nap-context-repo-con`).
 *   - Surfaces pending post-tool context (`worktree-after-release`, `worker-start-receipt`)
 *     and `secret-keywords` reminders.
 * - PreToolUse:
 *   - Both Direct & Worker:
 *     1. `privacy-checker` (.env, credentials, private keys across read_file/write_file/edit_file/run_command)
 *     2. `scout-checker` (.ckignore heavy directories across Read/Bash/Grep/Glob)
 *     3. `push-after-pr-guard` (blocks git push onto a branch with a MERGED/CLOSED PR/MR)
 *     4. `airflow-sql-guard` (blocks inline state-changing psql over ssh vps_airflow)
 *   - Direct interactive session (non-Orca worker):
 *     6. `nap-context-repo-con` (when in an umbrella workspace with `.claude/hooks/nap-context-repo-con.cjs`, blocks once per sub-repo/worktree per session before non-Read tools in `repos/*`, reminding to read `AGENTS.md`)
 *     5. `tier-c-guard` chain check (a production write after another step in the same call), workers included
 *     7. `tier-c-guard` (blocks `airflow dags pause|unpause|backfill` and `trigger --conf` when the latest user prompt is a question)
 *     8. `watch-guard` (blocks manual polling loops)
 *     9. `main-checkout-guard` (git writes into a main checkout: blocked once; `git -c core.hooksPath=...`: always)
 *    10. `dispatch-split-guard` (validates flags when running `orca orchestration worker-start`)
 *    11. `rules-budget` (enforces 24,000-byte cap on ~/.gemini/config/AGENTS.md; session-note caps come back as a reminder)
 * - PostToolUse:
 *   - Captures `worktree-after-release` and `worker-start-receipt` reminders.
 * - Stop:
 *   - Enforces the full `turn-guard` trio (`isEnglishReply`, `parkedProblem`, `handedGuess`).
 *
 * Empty stdout on PreToolUse / Stop leaves the decision to other hooks (orca-status).
 * Fails open on any unexpected error.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const HOOKS_DIR = path.join(CLAUDE_DIR, 'hooks');
const AGY_AGENTS_MD = path.join(HOME, '.gemini', 'config', 'AGENTS.md');

let platformLib = null;
try {
  platformLib = require(path.join(HOOKS_DIR, 'lib', 'platform.cjs'));
} catch (_) {
  try {
    platformLib = require(path.join(__dirname, '..', 'claude', 'hooks', 'lib', 'platform.cjs'));
  } catch (_) {
    platformLib = null;
  }
}

const expandHome = (p) => (platformLib ? platformLib.expandHome(p, HOME) : String(p || '').replace(/^~(?=[/\\]|$)/, HOME));
const samePath = (a, b) => (platformLib ? platformLib.samePath(a, b) : a === b);
const toSlash = (p) => (platformLib ? platformLib.toSlash(p) : (typeof p === 'string' ? p.replace(/\\/g, '/') : ''));

const EVENT = process.argv[2] || process.env.ORCA_ANTIGRAVITY_EVENT || '';

const TOOL_MAP = {
  read_file: 'Read',
  view_file: 'Read',
  write_file: 'Write',
  write_to_file: 'Write',
  edit_file: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  run_command: 'Bash',
  grep_search: 'Grep',
  find_by_name: 'Glob',
};

const TIER_C = /\bairflow\s+dags\s+(pause|unpause|backfill)\b|\bairflow\s+dags\s+trigger\b[^;&|'"\n]*?\s(-c|--conf)(\s|=)/;
const WORKER_START = /(?:^|[;&|({\n]\s*|\b(?:then|do)\s+)(?:\w+=\S*\s+)*orca\s+orchestration\s+worker-start\b/;
const WORKER_START_HELP = /\bworker-start\b[^;&|\n]*\s(?:--help|-h)\b/;

const stripHeredocs = (s) =>
  String(s || '').replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, '<<HEREDOC');
function findUmbrellaNapHook(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  while (true) {
    const candidate = path.join(dir, '.claude', 'hooks', 'nap-context-repo-con.cjs');
    if (fs.existsSync(candidate)) return { root: dir, hookPath: candidate };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The JSONL transcript of this conversation. agy chat (Orca's agy runtime) passes `transcriptPath` as
// `<home>/conversations/<id>.db`, a SQLite file; its JSONL copy is
// `<home>/brain/<id>/.system_generated/logs/transcript.jsonl`.
function transcriptFile(payload) {
  const tp = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
  try {
    if (!tp.endsWith('.db')) return tp;
    const id = String(payload.conversationId || path.basename(tp, '.db'));
    const jsonl = path.join(path.dirname(path.dirname(tp)), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
    return fs.existsSync(jsonl) ? jsonl : tp;
  } catch (_) {
    return tp;
  }
}

function readJsonLines(file, maxBytes = 512 * 1024, fromStart = false) {
  try {
    if (!file || !fs.existsSync(file)) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return [];
      const start = fromStart ? 0 : Math.max(0, size - maxBytes);
      const len = fromStart ? Math.min(size, maxBytes) : size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf8').split('\n');
      if (!fromStart && start > 0) lines.shift();
      if (fromStart && len < size) lines.pop();
      const parsed = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          parsed.push(JSON.parse(line));
        } catch (_) {}
      }
      return parsed;
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return [];
  }
}

function hasWorkerPreamble(text) {
  return (
    text.includes('You are working inside Orca, a multi-agent IDE. You are a dispatched worker.') ||
    (/\bScope:\s*\S/.test(text) && /\b(task_[0-9a-f]+|ctx_[0-9a-f]+|worker_done)\b/.test(text))
  );
}

function ancestorHasWorkerPreamble() {
  try {
    let procs;
    if (platformLib && typeof platformLib.listProcesses === 'function') {
      procs = platformLib.listProcesses();
    } else {
      const res = spawnSync('/bin/ps', ['-axww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 3000 });
      procs = new Map();
      for (const line of (res.stdout || '').split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s(.*)$/);
        if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
      }
    }
    let pid = process.ppid;
    for (let depth = 0; depth < 8 && pid > 1; depth++) {
      const p = procs.get(pid);
      if (!p) break;
      if (/(?:^|[/\\])agy(?:\.exe)?(?:\s|$)/i.test(p.args)) return hasWorkerPreamble(p.args);
      pid = p.ppid;
    }
  } catch (_) {}
  return false;
}

function isDispatchedWorker(payload) {
  const state = loadState(payload);
  if (state.mode === 'worker') return true;
  const headRecords = readJsonLines(transcriptFile(payload), 64 * 1024, true);
  const firstUser = headRecords.find((r) => r.type === 'USER_INPUT' && typeof r.content === 'string');
  const worker = (firstUser && hasWorkerPreamble(firstUser.content)) || ancestorHasWorkerPreamble();
  if (worker) saveState(payload, { ...state, mode: 'worker' });
  return worker;
}

function getStateDir(payload) {
  const dir = payload.artifactDirectoryPath;
  const cid = payload.conversationId;
  // CLI: brain/<conversationId>. artifactDirectoryPath holds conversationId and exists.
  if (dir && cid && String(dir).includes(String(cid)) && fs.existsSync(dir)) {
    return path.join(dir, '.system_generated');
  }
  // Orca chat: transcriptPath is <acp home>/conversations/<cid>.db,
  // with per-conversation directory at <acp home>/brain/<cid>/.system_generated.
  const tp = typeof payload.transcriptPath === 'string' ? payload.transcriptPath : '';
  if (tp.endsWith('.db') && cid) {
    const brainDir = path.join(path.dirname(path.dirname(tp)), 'brain', String(cid), '.system_generated');
    if (fs.existsSync(brainDir)) return brainDir;
  }
  return os.tmpdir();
}

function getStateFile(payload) {
  const dir = getStateDir(payload);
  if (dir !== os.tmpdir()) {
    return path.join(dir, 'agy-hook-state.json');
  }
  const id = (payload.conversationId || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(os.tmpdir(), `agy-hook-state-${id}.json`);
}

function loadState(payload) {
  try {
    const f = getStateFile(payload);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {}
  return {};
}

function saveState(payload, state) {
  try {
    const f = getStateFile(payload);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(state));
  } catch (_) {}
}

function queueEphemeral(payload, text) {
  if (!text) return;
  const state = loadState(payload);
  state.pendingEphemeral = state.pendingEphemeral ? `${state.pendingEphemeral}\n\n${text}` : text;
  saveState(payload, state);
}

function runClaudeHook(scriptName, claudePayload, timeoutMs = 8000) {
  try {
    const scriptPath = path.join(HOOKS_DIR, scriptName);
    if (!fs.existsSync(scriptPath)) return { status: 0, stdout: '', stderr: '' };
    const res = spawnSync(process.execPath, [scriptPath], {
      input: JSON.stringify(claudePayload),
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      status: res.status ?? 0,
      stdout: (res.stdout || '').trim(),
      stderr: (res.stderr || '').trim(),
    };
  } catch (_) {
    return { status: 0, stdout: '', stderr: '' };
  }
}

function handlePreInvocation(payload) {
  if (isDispatchedWorker(payload)) return;

  const cwd = payload.cwd || (payload.workspacePaths && payload.workspacePaths[0]) || process.cwd();
  const state = loadState(payload);
  const injectSteps = [];
  let stateChanged = false;

  const tailRecords = readJsonLines(transcriptFile(payload), 128 * 1024, false);
  let lastCheckpointIdx = -1;
  let lastUser = null;
  for (let i = tailRecords.length - 1; i >= 0; i--) {
    const rec = tailRecords[i];
    if (lastCheckpointIdx === -1 && rec.type === 'CHECKPOINT' && typeof rec.step_index === 'number') {
      lastCheckpointIdx = rec.step_index;
    }
    if (!lastUser && rec.type === 'USER_INPUT') {
      lastUser = rec;
    }
    if (lastCheckpointIdx !== -1 && lastUser) break;
  }

  // Clear sub-repo loaded set after compaction so sub-repo AGENTS.md is reminded again if needed
  if (typeof state.lastCheckpointIdx !== 'number') {
    state.lastCheckpointIdx = lastCheckpointIdx;
    stateChanged = true;
  } else if (lastCheckpointIdx > state.lastCheckpointIdx) {
    state.lastCheckpointIdx = lastCheckpointIdx;
    stateChanged = true;
    if (payload.conversationId) {
      const stateDir = getStateDir(payload);
      const napStateDir = process.env.NAP_CONTEXT_STATE_DIR ||
        path.join(stateDir !== os.tmpdir() ? stateDir : os.tmpdir(), 'claude-nap-context-repo-con');
      const safeKey = `${payload.conversationId}-main`.replace(/[^A-Za-z0-9_-]/g, '_');
      try {
        fs.rmSync(path.join(napStateDir, `${safeKey}.json`), { force: true });
      } catch (_) {}
    }
  }

  // Pending context from previous tool calls (worktree-after-release, worker-start)
  if (state.pendingEphemeral) {
    injectSteps.push({ ephemeralMessage: state.pendingEphemeral });
    delete state.pendingEphemeral;
    stateChanged = true;
  }

  if (lastUser && lastUser.step_index !== state.lastUserStepIdx) {
    state.lastUserStepIdx = lastUser.step_index;
    stateChanged = true;

    try {
      const { containsSecretKeyword } = require(path.join(HOOKS_DIR, 'lib', 'secret-keywords.cjs'));
      if (containsSecretKeyword(String(lastUser.content || ''))) {
        injectSteps.push({
          ephemeralMessage:
            'Security reminder: do not print raw credentials, API keys, tokens, JWTs, private keys, or secret values into the conversation. ' +
            'Use [redacted], variable names, counts, or high-level status.',
        });
      }
    } catch (_) {}
  }

  if (stateChanged) {
    saveState(payload, state);
  }

  if (injectSteps.length > 0) {
    process.stdout.write(JSON.stringify({ injectSteps }));
  }
}

// Tool args arrive as PascalCase (`AbsolutePath`) or snake_case (`absolute_path`), varying by call:
// give every snake_case key its PascalCase twin so each guard reads one spelling.
function normalizeArgs(args) {
  const out = { ...(args || {}) };
  for (const [k, v] of Object.entries(args || {})) {
    if (!k) continue;
    if (!k.includes('_') && k[0] === k[0].toUpperCase()) continue;
    const pascal = k.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    if (pascal && !(pascal in out)) out[pascal] = v;
  }
  return out;
}

// The key set of a hook payload (top level, then toolCall's own keys), the part a new agy version can
// change under the guards. Same function in bridge-fixtures/run.cjs, which compares what was seen.
function payloadShape(payload) {
  const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort().join(',') : '');
  return `${keys(payload)}|${keys(payload && payload.toolCall)}`;
}

// Records each payload shape this machine's agy sends (keys only, never values) with when it was last
// seen, so run.cjs can tell whether the installed agy still sends the shapes the fixtures replay.
// Written only for a new shape or one last seen over five minutes ago. Fixture runs (BRIDGE_FIXTURE) skip it.
const SHAPES_FILE = path.join(os.homedir(), '.gemini', 'config', 'bridge-fixtures', 'seen-shapes.json');
function recordShape(payload) {
  if (process.env.BRIDGE_FIXTURE) return;
  try {
    const shape = payloadShape(payload);
    let seen = {};
    try { seen = JSON.parse(fs.readFileSync(SHAPES_FILE, 'utf8')); } catch (_) { /* first one */ }
    const now = Date.now();
    if (seen[shape] && now - seen[shape] < 5 * 60 * 1000) return;
    seen[shape] = now;
    fs.mkdirSync(path.dirname(SHAPES_FILE), { recursive: true });
    // Written whole (temp + rename): a parallel bridge reading a half-written file would start from {}
    // and drop a shape run.cjs must see.
    const tmp = `${SHAPES_FILE}.${process.pid}.${now}`;
    fs.writeFileSync(tmp, JSON.stringify(seen, null, 2) + '\n');
    fs.renameSync(tmp, SHAPES_FILE);
  } catch (_) { /* a record lost costs one later check, never a guard */ }
}

function handlePreToolUse(payload) {
  recordShape(payload);
  const toolCall = payload.toolCall || {};
  const agyTool = toolCall.name || '';
  const args = normalizeArgs(toolCall.args);
  const claudeTool = TOOL_MAP[agyTool] || agyTool;
  const cwd = args.Cwd || payload.cwd || (payload.workspacePaths && payload.workspacePaths[0]) || process.cwd();
  const filePath =
    args.Path ||
    args.AbsolutePath ||
    args.TargetFile ||
    args.SearchPath ||
    args.SearchDirectory ||
    '';
  const command = args.CommandLine || '';
  const worker = isDispatchedWorker(payload);

  // 1. Privacy check (.env / credentials / private keys): the same verdict as Claude's
  // secret-file-guard, which judges a call by what it prints, so text that only names a secret
  // file (an `orca orchestration ask` body) is no read. That guard missing: the kit's checker.
  try {
    let reason = '';
    try {
      // From this checkout (the bridge is linked from it), so bridge and guard always change together.
      const local = path.join(__dirname, '..', 'claude', 'hooks', 'secret-file-guard.cjs');
      const { judge } = require(fs.existsSync(local) ? local : path.join(HOOKS_DIR, 'secret-file-guard.cjs'));
      // The guard's own wording names Claude's approval comment, which no agy worker can use: only its verdict is kept.
      const v = judge({ tool_name: claudeTool, tool_input: { file_path: filePath, command }, cwd }, { userTexts: () => [] });
      if (v.deny) {
        const what = v.uninspectable ? v.reason || 'a command the guard cannot read' : v.paths.join(', ');
        reason = v.fallback
          ? `PRIVACY BLOCK: the privacy checker did not load, so every call naming a secret-looking path is denied (${what}).`
          : `PRIVACY BLOCK: this call would print a secret file (${what}).`;
      }
    } catch (_) {
      const { checkPrivacy } = require(path.join(HOOKS_DIR, 'lib', 'privacy-checker.cjs'));
      const priv = checkPrivacy({ toolName: claudeTool, toolInput: { file_path: filePath, command }, options: { allowBash: true, cwd } });
      if (priv.blocked) reason = `PRIVACY BLOCK: ${priv.filePath} may contain secrets (API keys, passwords, tokens).`;
    }
    if (reason) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason:
            `${reason} ` +
            'Get approval before touching it: dispatched, ask the coordinator; direct, ask the person. ' +
            'Once approved, read it with a shell command. Otherwise continue without this file.',
        })
      );
      return;
    }
  } catch (_) {}

  // 2. Scout block (.ckignore ignored heavy directories)
  if (claudeTool === 'Read' || claudeTool === 'Bash' || claudeTool === 'Grep' || claudeTool === 'Glob') {
    try {
      const { checkScoutBlock } = require(path.join(HOOKS_DIR, 'lib', 'scout-checker.cjs'));
      const scout = checkScoutBlock({
        toolName: claudeTool,
        toolInput: {
          file_path: filePath,
          path: filePath,
          pattern: args.Query || args.Pattern || '',
          command,
        },
        options: {
          claudeDir: CLAUDE_DIR,
          cwd,
          projectConfigDirName: '.claude',
          ckignorePath: path.join(CLAUDE_DIR, '.ckignore'),
          checkBroadPatterns: true,
        },
      });
      if (scout.blocked && !scout.isAllowedCommand) {
        process.stdout.write(
          JSON.stringify({
            decision: 'deny',
            reason: `SCOUT BLOCK: Access to "${scout.path || scout.pattern || filePath}" is blocked by .ckignore (${scout.reason || 'ignored directory'}). Narrow your search path.`,
          })
        );
        return;
      }
    } catch (_) {}
  }

  // 3. Push-after-PR guard
  if (claudeTool === 'Bash' && /\bgit\b[^\n]*\bpush\b/.test(command)) {
    const res = runClaudeHook(
      'push-after-pr-guard.cjs',
      {
        tool_name: 'Bash',
        tool_input: { command },
        cwd,
      },
      15000
    );
    if (res.status === 2) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason: res.stderr || 'push-after-pr-guard: branch already has a closed/merged PR/MR.',
        })
      );
      return;
    }
  }

  // 4. Airflow SQL guard (blocks inline state-changing psql over ssh vps_airflow)
  if (claudeTool === 'Bash' && /\bssh\b/.test(command) && /\bpsql\b/.test(command)) {
    const res = runClaudeHook('airflow-sql-guard.cjs', {
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
    });
    if (res.status === 2) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason: res.stderr || 'airflow-sql-guard: SQL that changes state on vps_airflow Postgres must run via psql -f.',
        })
      );
      return;
    }
  }

  // 5. A production write after another step in the same call (tier-c-guard), for workers too.
  if (claudeTool === 'Bash') {
    try {
      const { chainedProdWrite } = require(path.join(HOOKS_DIR, 'tier-c-guard.cjs'));
      const chained = chainedProdWrite(command);
      if (chained) {
        process.stdout.write(JSON.stringify({
          decision: 'deny',
          reason: `tier-c-guard: \`${chained.slice(0, 120)}\` writes to production after another step in the same call. ` +
            'Run the earlier steps, read their output, then run the write alone in its own call.',
        }));
        return;
      }
    } catch (_) {}
  }

  if (worker) return;

  // 6. Umbrella sub-repo context guard (`nap-context-repo-con.cjs`)
  if (claudeTool !== 'Read' && payload.conversationId && `${cwd}\n${filePath}\n${command}\n${args.Query || ''}\n${args.Pattern || ''}`.includes('repos')) {
    const nap = (filePath && path.isAbsolute(filePath) && findUmbrellaNapHook(path.dirname(filePath))) ||
      findUmbrellaNapHook(cwd);
    if (nap) {
      try {
        process.env.CLAUDE_PROJECT_DIR = nap.root;
        const stateDir = getStateDir(payload);
        if (stateDir !== os.tmpdir() && !process.env.NAP_CONTEXT_STATE_DIR) {
          process.env.NAP_CONTEXT_STATE_DIR = path.join(stateDir, 'claude-nap-context-repo-con');
        }
        const { handle: napHandle } = require(nap.hookPath);
        const out = napHandle({
          session_id: payload.conversationId,
          hook_event_name: 'PreToolUse',
          tool_name: claudeTool === 'Bash' ? 'Bash' : 'Grep',
          cwd,
          tool_input: {
            command,
            path: filePath,
            pattern: args.Query || args.Pattern || '',
          },
        });
        if (out?.hookSpecificOutput?.permissionDecision === 'deny') {
          const rawReason = String(out.hookSpecificOutput.permissionDecisionReason || '');
          const agyReason = rawReason
            .replace(/(\bRead |, )([^,\n]+?[/\\])CLAUDE\.md\b/g, (_, prefix, dir) =>
              `${prefix}${fs.existsSync(`${dir}AGENTS.md`) ? `${dir}AGENTS.md` : `${dir}CLAUDE.md`}`)
            .replace(/\bRead\b/g, 'Dùng tool read_file đọc');
          process.stdout.write(
            JSON.stringify({
              decision: 'deny',
              reason: agyReason,
            })
          );
          return;
        }
      } catch (_) {}
    }
  }

  // 7. Tier-C guard: a tier-C Airflow step when the latest user message is a question.
  if (claudeTool === 'Bash' && TIER_C.test(stripHeredocs(command))) {
    try {
      const { isQuestion } = require(path.join(HOOKS_DIR, 'lib', 'user-intent.cjs'));
      const tail = readJsonLines(transcriptFile(payload), 128 * 1024, false);
      let lastUser = null;
      for (let i = tail.length - 1; i >= 0; i--) {
        if (tail[i].type === 'USER_INPUT' && typeof tail[i].content === 'string') {
          lastUser = tail[i];
          break;
        }
      }
      if (lastUser && isQuestion(lastUser.content)) {
        const quote = lastUser.content.replace(/\s+/g, ' ').slice(0, 160);
        const matched = TIER_C.exec(stripHeredocs(command))[0];
        process.stdout.write(
          JSON.stringify({
            decision: 'deny',
            reason:
              `tier-c-guard: "${matched}" is tier C, but the user's latest words ("${quote}") are a question, ` +
              'not a go-ahead. Answer the question first, say in one line what you would run, and ask (AGENTS.md § 3).',
          })
        );
        return;
      }
    } catch (_) {}
  }

  // 8. Watch guard
  if (claudeTool === 'Bash') {
    const bg = Boolean(args.IsDaemon);
    const res = runClaudeHook('watch-guard.cjs', {
      tool_name: 'Bash',
      // agy has no Bash timeout: a background watcher runs until watch.sh exits on its own.
      tool_input: { command, run_in_background: bg, ...(bg ? { timeout: 7200000 } : {}) },
      cwd,
      session_id: payload.conversationId,
    });
    if (res.status === 2) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason: res.stderr || 'watch-guard: polling loops must go through ~/.claude/scripts/watch.sh.',
        })
      );
      return;
    }
  }

  // 9. Main checkout guard (git writes into a main checkout: once; `git -c core.hooksPath=…`: always)
  if (claudeTool === 'Bash' && /\bgit\b/.test(command)) {
    const res = runClaudeHook('main-checkout-guard.cjs', {
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
      session_id: payload.conversationId,
    });
    if (res.status === 2) {
      process.stdout.write(JSON.stringify({ decision: 'deny', reason: res.stderr || 'main-checkout-guard: git write into a main checkout.' }));
      return;
    }
  }

  // 10. Orca worker-start flag guard (when dispatching workers via Orca)
  if (claudeTool === 'Bash' && WORKER_START.test(command) && !WORKER_START_HELP.test(command)) {
    const noEffort = /--agent[ =]['"]?antigravity\b/.test(command) && !/--terminal\b/.test(command) && !/--effort[ =]['"]?[^\s'"]/.test(command);
    let once = true;
    try { once = require(path.join(HOOKS_DIR, 'lib', 'block-once.cjs')).firstTime(payload.conversationId, 'dispatch-split-guard-effort', command); } catch (_) {}
    if (noEffort && once) {
      process.stdout.write(
        JSON.stringify({
          decision: 'deny',
          reason:
            'dispatch-split-guard: an antigravity worker needs `--effort` (e.g. `--model gemini-3.8-flash --effort high`); ' +
            'without it agy runs Medium. Said once: if the command is right as it is, run it again unchanged.',
        })
      );
      return;
    }
  }

  // 11. Rules budget guard
  if ((claudeTool === 'Write' || claudeTool === 'Edit') && filePath) {
    const resolved = path.resolve(expandHome(filePath));
    const newContent = String(args.Content ?? args.CodeContent ?? '');
    const targetText = String(args.Target ?? args.TargetContent ?? '');
    const replacementText = String(args.Replacement ?? args.ReplacementContent ?? '');
    if (samePath(resolved, AGY_AGENTS_MD)) {
      const nextContent =
        claudeTool === 'Write'
          ? newContent
          : fs.existsSync(resolved)
          ? fs.readFileSync(resolved, 'utf8').replace(targetText, replacementText)
          : '';
      if (Buffer.byteLength(nextContent, 'utf8') > 24000) {
        process.stdout.write(
          JSON.stringify({
            decision: 'deny',
            reason: `rules-budget: ~/.gemini/config/AGENTS.md would exceed the 24,000-byte Antigravity limit (${Buffer.byteLength(nextContent, 'utf8')} bytes). Cut before you add.`,
          })
        );
        return;
      }
    } else {
      const claudeInput =
        claudeTool === 'Write'
          ? { file_path: resolved, content: newContent }
          : {
              file_path: resolved,
              old_string: targetText,
              new_string: replacementText,
              replace_all: Boolean(args.AllowMultiple),
            };
      const res = runClaudeHook('rules-budget.cjs', {
        tool_name: claudeTool,
        tool_input: claudeInput,
        cwd,
      });
      try {
        const ctx = res.stdout && JSON.parse(res.stdout).hookSpecificOutput?.additionalContext;
        if (ctx) queueEphemeral(payload, ctx);
      } catch (_) {}
    }
  }
}

function handlePostToolUse(payload) {
  if (isDispatchedWorker(payload)) {
    process.stdout.write('{}\n');
    return;
  }
  const toolCall = payload.toolCall || {};
  const args = normalizeArgs(toolCall.args);
  const command = String(args.CommandLine || '');
  const toolOutput = String(payload.toolOutput || payload.output || '');

  if (toolCall.name === 'run_command') {
    if (/\borca\s+orchestration\s+worker-release\b/.test(command)) {
      const res = runClaudeHook(
        'worktree-after-release.cjs',
        {
          tool_name: 'Bash',
          tool_input: { command },
        },
        10000
      );
      if (res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout);
          const ctx = parsed?.hookSpecificOutput?.additionalContext;
          if (ctx) queueEphemeral(payload, ctx);
        } catch (_) {}
      }
    }

    if (WORKER_START.test(command) && !WORKER_START_HELP.test(command)) {
      for (const hookName of ['worker-start-receipt.cjs']) {
        const res = runClaudeHook(
          hookName,
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command },
            tool_response: { stdout: toolOutput, stderr: '' },
          },
          12000
        );
        if (res.stdout) {
          try {
            const parsed = JSON.parse(res.stdout);
            const ctx = parsed?.hookSpecificOutput?.additionalContext;
            if (ctx) queueEphemeral(payload, ctx);
          } catch (_) {}
        }
      }
    }
  }

  process.stdout.write('{}\n');
}

function handleStop(payload) {
  if (isDispatchedWorker(payload)) return;
  if (payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL') return;

  const tail = readJsonLines(transcriptFile(payload), 256 * 1024, false);
  let lastPlanner = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].type === 'USER_INPUT') break;
    if (tail[i].type === 'PLANNER_RESPONSE' && typeof tail[i].content === 'string' && tail[i].content.trim()) {
      lastPlanner = tail[i];
      break;
    }
  }
  if (!lastPlanner) return;

  const state = loadState(payload);
  if (state.lastTurnGuardStepIdx === lastPlanner.step_index) return;

  const reply = lastPlanner.content.replace(/^Restate:[\s\S]*?^Scope:.*$/gm, ' ');
  const notes = [];

  try {
    const { isEnglishReply, parkedProblem, handedGuess } = require(path.join(HOOKS_DIR, 'turn-guard.cjs'));
    if (isEnglishReply(reply)) {
      notes.push(
        'the reply you just ended the turn with is in English. Send it again in Vietnamese, labels included (AGENTS.md § 6); technical terms and code stay as they are.'
      );
    }
    const parked = parkedProblem(reply);
    if (parked) {
      notes.push(
        `the reply names a problem it leaves ("${parked}") with no PR/MR/Issue ref on that line and no ask. ` +
          'Re-check it; if it is real, fix it now in its own PR and report the link, or ask the user once with your question tool, never as a **Cần bạn:** line.'
      );
    }
    const guess = handedGuess(reply);
    if (guess) {
      notes.push(
        `the reply voices a guess ("${guess}") and hands the user a check. Run every read you can that confirms or refutes it first, ` +
          'then answer with the cause and its evidence (AGENTS.md § 2). Only a check no tool of yours can reach goes to the user, saying why.'
      );
    }
  } catch (_) {}

  if (notes.length > 0) {
    state.lastTurnGuardStepIdx = lastPlanner.step_index;
    saveState(payload, state);
    process.stdout.write(
      JSON.stringify({
        decision: 'continue',
        reason: `turn-guard: ${notes.join(' Also: ')}`,
      })
    );
  }
}

let rawInput = '';
process.stdin.on('data', (chunk) => {
  rawInput += chunk;
});
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(rawInput || '{}');
    switch (EVENT) {
      case 'PreInvocation':
        handlePreInvocation(payload);
        break;
      case 'PreToolUse':
        handlePreToolUse(payload);
        break;
      case 'PostToolUse':
        handlePostToolUse(payload);
        break;
      case 'Stop':
        handleStop(payload);
        break;
      default:
        break;
    }
  } catch (_) {
    // fail-open
  }
});

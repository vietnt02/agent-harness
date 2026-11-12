#!/usr/bin/env node
/**
 * turn-guard.cjs - checks the model cannot do for itself.
 * - UserPromptSubmit: when the session runs with bypass permissions (`permission_mode`
 *   is "bypassPermissions", verified 2026-10-12 against a live `claude -p` run), remind
 *   that inside a block the user assigned they want the finished chain (CLAUDE.md § Mutation gate,
 *   Standing permission, "làm đến end"), and that a message naming no change opens no block: read
 *   as "run to the end" alone, the reminder turned a fact the user reported into a chain of tier-C
 *   steps. The model never sees the permission mode itself.
 * - Stop: a final reply written in English (2026-10-12, two reports after a compaction)
 *   is sent back to be rewritten in Vietnamese (communication-style.md § Language).
 * - Stop: a final reply that names a problem it left (a drift, a leftover, out of scope) with no
 *   PR/MR/Issue ref on that line and no `**Cần bạn:**` line is sent back to fix it (CLAUDE.md
 *   § Mutation gate: a found defect is fixed in its own PR, the report carries its link).
 * - Stop: a final reply that voices a guess ("rất có thể", "có lẽ", "nghi") and hands the user a
 *   check ("bạn kiểm", "đăng xuất rồi đăng nhập lại") is sent back to run the reads that settle the
 *   guess first (CLAUDE.md § Verification: proactive in thinking, never hand me a read-only check).
 * - Stop: a final reply asking the user more than one thing (two `**Cần bạn:**` lines, or one whose
 *   block holds two questions) is sent back to keep one: a short answer must say which
 *   ask it settles (communication-style.md § Format: its one question).
 *   The Stop checks report together: after one send-back `stop_hook_active` skips them.
 * Fails open on any error.
 */
const BYPASS_NOTE =
  'turn-guard: bypass permissions is on. Inside a block the user assigned (an instruction naming the change, ' +
  'or a yes to your ask) they expect the finished chain (CLAUDE.md § Mutation gate, Standing permission, ' +
  '"làm đến end"): settle open questions before starting (one per reply, communication-style.md), then run to the end. Steps that bring an ' +
  'approved change to its target need no new ask; never wait on a schedule or controller to do a step you ' +
  'can do now. Tier C outside what was approved is asked the moment you know it, never after waiting. ' +
  'A message that names no change (a fact, a question, an opinion), or arrives after the block closed, ' +
  'opens no block: answer it, name the work it opens in one line, ask.';

const VI_LETTERS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/gi;

// True when the visible prose of `text` is long enough to judge and carries almost no
// Vietnamese letters. Code, inline code and URLs are ignored: they are English anyway.
function isEnglishReply(text) {
  const prose = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  const letters = (prose.match(/\p{L}/gu) || []).length;
  if (letters < 120) return false;
  return (prose.match(VI_LETTERS) || []).length / letters < 0.02;
}

const PARKED = /(còn\s+lệch|(doc|docs|tài liệu|README)\s+(đang\s+|vẫn\s+|bị\s+)?lệch|còn\s+sót|ngoài\s+scope|out of scope|not in scope|\bparked\b|để\s+(lại\s+)?sau\s*([.,;)]|$)|(lỗi|bug|doc|docs|tài liệu|file)\b[^.\n]{0,30}chưa\s+(sửa|fix|cập nhật))/i;
const REF = /(https?:\/\/\S+\/(pull|merge_requests|issues)\/\d+|\b(PR|MR|[Ii]ssue)\s*[#!]\d+|[\w.-]+\/[\w.-]+(?<!\.(md|html?|txt))[#!]\d+|(^|\s)[\w-]+!\d+\b)/;
const ASK = /\*\*Cần bạn:?\*\*:?/;

// The phrase naming a problem the reply leaves behind, or null. Judged per line, sentence by
// sentence: a sentence that names a problem needs a PR/MR/Issue ref in itself or the next sentence
// of that line, unless the reply asks the user in a **Cần bạn:** line. Code blocks never count;
// inline code and quotes cite, so they name nothing; a question, a negation ("không … còn sót")
// or a condition ("… lệch thì …") is not a report.
function parkedProblem(text) {
  const lines = String(text || '').replace(/```[\s\S]*?```/g, ' ').split('\n');
  const prose = (l) => l.replace(/`[^`]*`/g, ' ').replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  if (lines.some((l) => ASK.test(prose(l)))) return null;
  for (const line of lines) {
    const sentences = line.split(/(?<=[.;!?])\s+(?=\S)/);
    for (let k = 0; k < sentences.length; k++) {
      const p = prose(sentences[k]);
      if (p.trim().endsWith('?')) continue;
      const m = p.match(PARKED);
      if (!m) continue;
      const before = p.slice(0, m.index);
      const after = p.slice(m.index + m[0].length);
      // A negation or a condition ("nếu doc lệch", "doc lệch thì sửa") states a rule, not a leftover.
      if (/(không|nếu|khi|gặp)\s+(\S+\s+){0,3}$/i.test(before) || /^\s*thì(\s|[,.]|$)/i.test(after)) continue;
      // A label naming a kind of problem ("Tài liệu lệch thực tế: …" opening a line or a table cell)
      // defines it, it reports none.
      const cell = before.slice(before.lastIndexOf('|') + 1);
      if (/^\s*(?:[-*]\s+|\d+[.)]\s+)?(?:\*\*)?$/.test(cell) && /^[^.;:!?|\n]{0,40}(?:\*\*)?\s*:/.test(after)) continue;
      if (!REF.test(sentences[k]) && !REF.test(sentences[k + 1] || '')) return m[0];
    }
  }
  return null;
}

// A guess voiced as the answer, and a check handed to the user. Plain "có thể" ("can") is too
// common to count; only the forms that mark a guess do.
const HEDGE = /(rất\s+có\s+thể|có\s+thể\s+(là|do)|nhiều\s+khả\s+năng|khả\s+năng\s+cao|có\s+khả\s+năng|có\s+lẽ|có\s+vẻ\s+như|hình\s+như|nghi\s+(là|ngờ)|đoán\s+là|chắc\s+là|chưa\s+chắc)/i;
// A check handed over in a sentence ("bạn kiểm", "nhờ bạn thử", "xem giúp")...
const HANDOFF = /(bạn\s+(tự\s+|có\s+thể\s+|nên\s+|hãy\s+|cần\s+|vui\s+lòng\s+)?(kiểm|check|xác\s+nhận|verify|thử|xem\s+giúp|đăng\s+xuất|đăng\s+nhập\s+lại|cho\s+biết)|(kiểm|xác\s+nhận|xem)\s+giúp|nhờ\s+bạn\s+(kiểm|xác\s+nhận|thử|xem)|hãy\s+thử)/i;
// ...or as the user's step in the house style: an imperative after a **Cần bạn:** / **Cách xử lý:**
// label, on its line or in the list items right under it (communication-style.md: imperative = the
// human's step).
const STEP_LABEL = /\*\*(Cần bạn|Cách xử lý|Bạn cần|Việc của bạn|Bước tiếp|Tiếp theo|Việc cần làm):?\*\*:?/i;
const CHECK_STEP = /^(\*\*)?(tự\s+)?(kiểm|thử|xem|xác\s+nhận|cho\s+(claude\s+)?biết|đăng\s+xuất|đăng\s+nhập\s+lại|tải\s+lại|mở|vào|chạy|nhập|gửi|chụp)/i;
const ITEM = /^\s*([-*]|\d+[.)])\s+/;

function handsCheck(prose) {
  if (HANDOFF.test(prose)) return true;
  const lines = prose.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STEP_LABEL);
    if (!m) continue;
    const steps = [lines[i].slice(m.index + m[0].length)];
    // The list under the label, past blank lines; it ends at the first other line.
    for (let k = i + 1; k < lines.length && (ITEM.test(lines[k]) || !lines[k].trim()); k++) {
      if (lines[k].trim()) steps.push(lines[k].replace(ITEM, ''));
    }
    if (steps.some((s) => CHECK_STEP.test(s.trim()))) return true;
  }
  return false;
}

// The heading and first paragraph: where the reply states its answer (communication-style.md § Format).
function leadOf(prose) {
  const lines = prose.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const lead = [];
  if (/^#/.test(lines[i] || '')) lead.push(lines[i++]);
  while (i < lines.length && !lines[i].trim()) i++;
  while (i < lines.length && lines[i].trim()) lead.push(lines[i++]);
  return lead.join('\n');
}

// The guess phrase when the reply's answer (heading, first paragraph) is a guess and the reply hands
// the user a check, or null. Code, inline code and quotes never count, nor a negated handoff ("không
// phải bạn tự kiểm"), a question, a guess told as already settled ("lúc đầu Claude nghi là…"; this
// also skips "trước đó" used as a time mark), or a guess about what the user wants ("có lẽ bạn muốn…"),
// which is a business question Claude may ask. A guess at a cause outside the system followed by a
// business question still trips once; stop_hook_active lets the second stop through.
function handedGuess(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ');
  if (!handsCheck(prose.replace(/(không|chẳng)\s+(phải|cần)\s+bạn[^.;\n]*/gi, ' '))) return null;
  for (const sentence of leadOf(prose).split(/(?<=[.;!?])\s+|\n/)) {
    if (sentence.trim().endsWith('?') || /(lúc|ban)\s+đầu|trước\s+đó|bạn\s+(muốn|cần|định|chọn)/i.test(sentence)) continue;
    const m = sentence.match(HEDGE);
    if (m) return m[0];
  }
  return null;
}

// The asks of a reply when it holds more than one, else null: two `**Cần bạn:**` lines, or two `?` in
// the block of one (that line up to a blank line). A list under it is not counted: the ask to allow a
// blocked command lists its rule, settings file and impact, and a closed choice lists its options.
// Code, inline code and URLs never count.
function manyAsks(text) {
  const lines = String(text || '').replace(/```[\s\S]*?```/g, ' ').split('\n')
    .map((l) => l.replace(/`[^`]*`/g, ' ').replace(/https?:\/\/[^\s)]+?(?=[?!.,;:]*(?:[\s)]|$))/g, ' '));
  const at = lines.map((l, i) => (ASK.test(l) ? i : -1)).filter((i) => i >= 0);
  if (at.length >= 2) return `${at.length} \`**Cần bạn:**\` lines`;
  if (!at.length) return null;
  const block = [];
  for (let i = at[0]; i < lines.length && (i === at[0] || lines[i].trim()); i++) block.push(lines[i]);
  const prose = block.filter((l, i) => i === 0 || !/^\s*([-*+]|\d+[.)])\s/.test(l));
  const questions = (prose.join('\n').match(/\?/g) || []).length;
  return questions >= 2 ? `${questions} questions in the \`**Cần bạn:**\` block` : null;
}

const asksNote = (what) =>
  `the reply asks the user more than one thing (${what}). Keep the one ask this topic needs now; the others ` +
  'wait for later replies, so a short answer ("không", "ok") can only mean one thing (communication-style.md § Format).';

const ENGLISH_NOTE =
  'the reply you just ended the turn with is in English. Send it again in Vietnamese, labels ' +
  'included (communication-style.md § Language); technical terms and code stay as they are.';
const parkedNote = (phrase) =>
  `the reply names a problem it leaves ("${phrase}") with no PR/MR/Issue ref on that line and no ` +
  '**Cần bạn:** line. Re-check it; if it is real, fix it now in its own PR and report the link; ' +
  'only a business call or a tier-C step goes to the user as one **Cần bạn:** question ' +
  '(CLAUDE.md § Mutation gate). If you were wrong about it, drop the line.';

const guessNote = (phrase) =>
  `the reply voices a guess ("${phrase}") and hands the user a check. Run every read you can (lists, ` +
  'memberships, audit logs, config) that confirms or refutes it, then answer with the cause and its ' +
  'evidence (CLAUDE.md § Verification: never hand me a read-only check). Only a check no tool of yours ' +
  'can reach goes to the user, saying why.';

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      if (input.hook_event_name === 'UserPromptSubmit' && input.permission_mode === 'bypassPermissions') {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: BYPASS_NOTE },
        }));
      }
      if (input.hook_event_name === 'Stop' && !input.stop_hook_active) {
        const reply = input.last_assistant_message;
        const parked = parkedProblem(reply);
        const guess = handedGuess(reply);
        const asks = manyAsks(reply);
        const notes = [isEnglishReply(reply) && ENGLISH_NOTE, parked && parkedNote(parked), guess && guessNote(guess),
          asks && asksNote(asks)]
          .filter(Boolean);
        if (notes.length) {
          process.stderr.write(`turn-guard: ${notes.join(' Also: ')}\n`);
          process.exit(2);
        }
      }
    } catch (_) { /* fail-open */ }
    process.exit(0);
  });
}

module.exports = { isEnglishReply, parkedProblem, handedGuess, manyAsks };

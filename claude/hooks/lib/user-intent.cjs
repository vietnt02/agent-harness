/**
 * user-intent.cjs - what the user's latest words mean, shared by answer-first, session-notes,
 * tier-c-guard and secret-file-guard so they never disagree on "is this a question / an approval"
 * or on which entries the user typed.
 */
const fs = require('fs');

// A message Orca delivers into the session (a worker's report or ask) is stored like a typed
// prompt; only its header tells it apart: `──── From: <ID> (<id>) (worker_done) ────`, with or
// without a priority (`[HIGH]`) or a type.
const ORCA_MESSAGE = /^─+ From: \S+ \(\S+\)/;

// Approval words, or a bare numbered answer ("1 2 3") to an ask.
const DECISION_RE =
  /^[\s\d,]+$|(^|[^\p{L}])(ok|okay|duyệt|chốt|đồng ý|làm hết|làm luôn|làm đi|làm tiếp|chạy đi|triển khai|merge|follow deploy|approved?)(?=$|[^\p{L}])/iu;

// Question words that only ask at the end of a clause ("không cần" is not a question).
const TRAILING = /(?:^|\s)(gì|sao|nào|không|ko|chưa|nhỉ|à|hả|hở)$/;
// A set phrase that ends in one of those words without asking.
const NOT_ASKING = /không sao$/;
// A clause opening with "sao" asks ("thế sao nãy cứ chờ mà không làm luôn").
const LEADING = /^(thế\s+|vậy\s+)?(sao|tại sao|vì sao)\s(?!(chép|lưu|kê)(\s|$))/;
// Phrases that ask wherever they appear.
const ANYWHERE = /(tại sao|vì sao|sao lại|sao không|sao vậy|thế nào|làm sao|bao giờ|bao nhiêu|khi nào|ở đâu|là gì|cái gì)/;

function isQuestion(text) {
  const t = text.toLowerCase();
  if (t.includes('?') || ANYWHERE.test(t)) return true;
  return t
    .split(/[.!,;:\n]+/)
    .map((s) => s.trim())
    .some((s) => LEADING.test(s) || (TRAILING.test(s) && !NOT_ASKING.test(s)));
}

// The text of a user prompt record, or null when the record is not one: a prompt is stored as a
// string or as an array of `text` / `image` blocks (a hook added context, the user pasted an
// image; the text may then be empty); an array holding a `tool_result` is a tool answer, and the
// summary written after a compact is not the user's words.
// `<system-reminder>` parts are dropped.
function promptText(rec) {
  if (!rec || rec.type !== 'user' || rec.isMeta || rec.isCompactSummary) return null;
  const c = rec.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && c.length && c.every((b) => b && (b.type === 'text' || b.type === 'image'))) {
    text = c.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  }
  else return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // Harness records stored as user strings, not the user's words: a background task's or subagent's
  // result, a `!` shell command and its output, a slash command and its output.
  if (/^<(task-notification|bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr|command-name|command-message)>/.test(text)) return null;
  if (ORCA_MESSAGE.test(text)) return null;
  return /^This session is being continued from a previous conversation/.test(text) ? null : text;
}

// The texts of the transcript's user prompts (not tool results, meta lines, notifications or Orca
// messages), in order, NFC with LF line ends. `maxBytes` reads only the head of the file.
function userTexts(transcript, maxBytes = Infinity) {
  let raw = '';
  try {
    if (maxBytes === Infinity) raw = fs.readFileSync(transcript, 'utf8');
    else {
      const fd = fs.openSync(transcript, 'r');
      const buf = Buffer.alloc(maxBytes);
      raw = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, maxBytes, 0));
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || d.isMeta || !d.message || d.isCompactSummary) continue;
    // A task notification or a message from another session carries `origin.kind` other than `human`.
    if (d.origin && typeof d.origin === 'object' && d.origin.kind && d.origin.kind !== 'human') continue;
    const c = d.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join('\n') : '';
    const t = text.trim();
    if (!t || /^<(command-|local-command|system-reminder|task-notification)/.test(t) || ORCA_MESSAGE.test(t)) continue;
    out.push(t.normalize('NFC').replace(/\r\n?/g, '\n'));
  }
  return out;
}

module.exports = { DECISION_RE, isQuestion, promptText, userTexts, ORCA_MESSAGE };

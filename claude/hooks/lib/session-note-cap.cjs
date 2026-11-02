/**
 * session-note-cap.cjs - the size and shape a session note may take (rules/mine/session-notes.md:
 * only what a compact would make Claude get wrong; detail is re-read from the session jsonl).
 * Capped per section, not in total: a total cap made the sections compete, so a long `Đang làm`
 * squeezed out approvals. `Đang làm` and `Resume` never grow with the session: capped whole.
 * `Đang có hiệu lực` (one approval or decision a line) and `Đã xong` (one closed topic a line) grow
 * with the work done: capped per line, any number of lines. Counted in characters: a line cap
 * alone let notes grow by writing longer lines.
 */

// The only `## ` sections a note holds, in this order.
const NOTE_SECTIONS = ['Đang làm', 'Đang có hiệu lực', 'Đã xong', 'Resume'];
const SECTION_CAPS = { 'Đang làm': 300, Resume: 300 };
const LINE_CAPS = { 'Đang có hiệu lực': 250, 'Đã xong': 150 };
// What to cut when a cap is passed, per section.
const HOW_TO_CUT = {
  'Đang làm': 'keep one topic and its next step; the story so far is re-read from the session jsonl',
  Resume: 'IDs only',
  'Đang có hiệu lực': "keep Viet's words and what they cover; a decision an issue, PR or comment now holds becomes its link",
  'Đã xong': 'one closed topic: its result link and the uuid of the opening message',
};

// Body text of each `## ` section outside code fences, front matter excluded.
function sections(text) {
  const out = {};
  let fence = false;
  let cur = null;
  const body = String(text || '').normalize('NFC').replace(/^---\n[\s\S]*?\n---/, '');
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence && line.match(/^##\s+(.+?)\s*$/);
    if (m) { cur = m[1]; out[cur] = out[cur] || []; continue; }
    if (cur) out[cur].push(line);
  }
  return out;
}

// `## ` headings outside code fences that are not one of NOTE_SECTIONS.
function strayHeadings(text) {
  return Object.keys(sections(text)).filter((s) => !NOTE_SECTIONS.includes(s));
}

// Every cap the note passes: { section, line, n, msg }; `line` marks a per-line cap.
function overCaps(text) {
  const out = [];
  for (const [name, lines] of Object.entries(sections(text))) {
    if (SECTION_CAPS[name]) {
      const n = lines.join('\n').trim().length;
      if (n > SECTION_CAPS[name]) {
        out.push({ section: name, line: false, n, msg: `"## ${name}" is ${n} chars (cap ${SECTION_CAPS[name]}): ${HOW_TO_CUT[name]}` });
      }
    }
    if (LINE_CAPS[name]) {
      for (const line of lines) {
        const n = line.trim().length;
        if (n > LINE_CAPS[name]) {
          out.push({ section: name, line: true, n,
            msg: `a "## ${name}" line is ${n} chars (cap ${LINE_CAPS[name]} a line): "${line.trim().slice(0, 60)}…": ${HOW_TO_CUT[name]}` });
        }
      }
    }
  }
  return out;
}

// The caps an edit newly passes: a section that grew past its cap, or a section holding more
// over-cap lines, or a longer one, than before. Shortening or editing an old over-cap line passes.
function newOverCaps(before, after) {
  const group = (list) => {
    const m = new Map();
    for (const v of list) {
      const k = `${v.section}\n${v.line}`;
      const g = m.get(k) || { count: 0, max: 0 };
      m.set(k, { count: g.count + 1, max: Math.max(g.max, v.n) });
    }
    return m;
  };
  const old = group(overCaps(before));
  const now = overCaps(after);
  const grown = new Set([...group(now)].filter(([k, g]) => {
    const o = old.get(k) || { count: 0, max: 0 };
    return g.count > o.count || g.max > o.max;
  }).map(([k]) => k));
  return now.filter((v) => grown.has(`${v.section}\n${v.line}`));
}

module.exports = { NOTE_SECTIONS, SECTION_CAPS, LINE_CAPS, strayHeadings, overCaps, newOverCaps };

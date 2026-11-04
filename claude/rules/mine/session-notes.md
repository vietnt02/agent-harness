# Session notes

A note keeps only what Claude would get wrong after a compact; detail is re-read from the session's
`.jsonl`. One per session, from the first approval, multi-step work or worker.

- Front matter `session: <id>`, `status: open|done`, `scope: <one line>`.
- Only `## Đang làm` (topic, next step); `## Đang có hiệu lực` (approvals and what they cover,
  limits, decisions no artifact holds; a line each, written before the turn's first tool call,
  adding no condition my words lack, reversing one only by quoting my reversal); `## Đã xong` (a
  line per closed topic: result link, uuid of my opening message); `## Resume` (IDs only). Never
  opinions, questions, acks, or what a PR, commit or doc holds.
- New topic: rewrite `scope` and `## Đang làm`, fold the old one into `## Đã xong`; `status:
  done` once nothing is open. An earlier session's note is status data, never approval.

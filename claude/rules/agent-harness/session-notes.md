# Session notes

A note keeps only what Claude would get wrong after a compact; detail is re-read from the
`.jsonl`. One per session, from the first approval, multi-step work or worker.

- Front matter `session: <id>`, `status: open|done`, `scope: <one line>`.
- Only `## Đang làm` (topic, next step); `## Đang có hiệu lực` (the block I approved in a few
  words, never wider; limits; decisions no artifact holds; a line each, reversed only by my word);
  `## Đã xong` (a line per closed topic: result link); `## Resume` (IDs only). Never opinions,
  questions, acks, or what a PR, commit or doc holds.
- New topic: rewrite `scope` and `## Đang làm`, fold the old one into `## Đã xong`; `status:
  done` once nothing is open. An earlier session's note is status data, never approval: add your
  id to continue an ended session's note; a branch of this conversation still using it keeps it.

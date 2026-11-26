# Orca — lệnh và hành vi theo bản

Phần của `ntv-orca` gắn với cách Orca chạy: lệnh, cờ, trạng thái, bẫy. Orca đổi bản thì chỉ file này
đổi; vai, giao việc, review và cổng ở `SKILL.md`. Lệnh đầy đủ: `orca <lệnh> --help`; giám sát, nhắn
tin, gỡ lỗi: `orca skills get orchestration`. Máy và Settings đang dùng: `~/.claude/knowledge/orca.md`.

## Giao worker

- Worker tên `w<N>-<việc>` (`SKILL.md` § 2) đi vào `--task-title` và mọi báo cáo; `--name`,
  `--display-name` chỉ thêm khi `--worktree new-child|new-top-level`.
- **Worktree:** repo có quy ước worktree trong `AGENTS.md`/`docs/` thì theo quy ước đó (thường
  `git worktree add` rồi `--worktree path:<abs>`; `path:` chỉ nhận worktree của repo đã có trong Orca,
  `orca worktree ps --json`: repo mới thì `orca repo add --path <repo>` trước); không có thì
  `--worktree new-child`. Worktree `path:` không chạy Setup Script: chạy tay trước khi spawn (script:
  `knowledge/orca.md`). Worker cần harness của repo con (MCP, hook, skill) phải chạy với cwd ở repo
  đó; coordinator ở umbrella không gọi được MCP của repo con. Nhiều worktree cùng repo chạy dev server
  thì spec cấp port riêng kèm `--strictPort`.
- **Model:** truyền `--agent`, `--model` (slug thật), `--effort` đúng frontmatter của dòng model
  (reviewer, checker: `high`). Slug: agy `agy models`; codex `~/.codex/models_cache.json`
  (`references/lessons.md`: lỗi sai slug). Orca không ghi model của worker agy (`launch.requested`,
  `launch.effective` đều null): model thật là banner trong terminal (`Gemini 4 Neon (High)`), lệnh
  watch mà receipt in so banner đó với `--model` đã giao ở lần kiểm đầu thấy banner, lệch thì báo.

## Trong lúc chạy

- **Không poll hộp thư:** process nào khác đọc `orca orchestration check` là lấy mất tin, và Orca
  không còn tin để đánh thức coordinator. Mỗi lần được đánh thức, chạy đúng lệnh `check` của lời nhắc.
- **Giao tiếp cho đúng worker** (`SKILL.md` § 3): `send --to dispatch:<id>` (thành Task mới). Trước khi
  `send` cho worker đã `worker_done`, đọc `worker-show --json` của dispatch mới nhất trong chuỗi
  (follow-up giữ terminal, nên dispatch gốc không báo released; `worker-list --json` theo
  `workspace`): `terminalState: released` → không `send` (Orca mở lại nó, in `delivery=reopened`,
  không kèm `--model`, `--effort`), giao bằng `worker-start --spec-file` (spec cũ, nội dung tin, câu
  kiểm hộp thư) kèm `--worktree path:` cũ, `--agent`, `--model`, `--effort` theo `SKILL.md` § 2; `send`
  đã in `delivery=reopened` → `worker-stop` dispatch mới đó rồi giao như vậy.
- **Tin `send` tới worker Chat đang trong lượt:** ngắt lượt đó hay nằm Queued tới lần `check --peek`
  kế tiếp mà spec đòi là tuỳ bản Orca (`~/.claude/knowledge/orca.md`); khung chat của worker cho thấy
  lượt mới, `worker-read --source transcript` thì không. Tin gấp mà worker không làm theo trong vài
  phút (đang chạy một lệnh dài, hoặc spec giao trước khi có câu kiểm hộp thư) → coordinator tự
  `worker-stop`, rồi `worker-start --spec-file` mới gồm spec cũ, nội dung tin và câu kiểm hộp thư, cùng
  `--worktree path:` cũ; không nhờ user bấm Steer, không chờ user.
- **Release:** runtime có `orchestration.worker-auto-release.v1` (`orca status --json`,
  `runtime.capabilities`) tự release worker khoảng 2 phút sau khi nhận `worker_done` và hoãn khi một tin
  làm worker chạy lại, nên coordinator không `worker-release` tay (release lúc thư còn trong hộp làm
  Orca báo HIGH giả). Worker được giữ mở (spawn kèm `--worktree new-child`, `--worktree new-top-level`
  hay `--keep-open`) không tự release: `worker-release` sau khi kiểm xong và không còn việc kế tiếp cho
  nó. Có việc kế tiếp cho đúng worker đó → `worker-keep-open` ngay khi nhận `worker_done`, xong việc đó
  thì `worker-release`. Runtime không có capability đó → `worker-release` sau khi kiểm xong (chỉ worker
  đã `worker_done`, chưa thì `worker-stop`). Gỡ worktree khi `worker-show` báo `terminalState:
  released` và báo cáo đã lưu.

## Khi có sự cố

Trạng thái Orca báo là claim của Orca; sự thật lấy từ thứ không đi qua Orca (`git -C <worktree> log`,
`git status --short`, PR, transcript của worker). Còn lại: guide `references/recovery-and-cleanup.md`.

| Triệu chứng | Làm gì |
|---|---|
| `worker-start` lỗi | Không chạy lại y nguyên; đọc `failedStage`, `next` của receipt (hook `worker-start-receipt` in sẵn dòng liên quan). Ba lần lỗi trong một chuỗi `--retry-of` thì Task bị khoá, chỉ mở lại khi user yêu cầu. |
| Sau khi Orca restart | `worker-list --run <run> --json` và `ps` trước; thử giao tiếp worker cũ trước khi spawn mới. |
| Worker Claude thoát về shell ở repo lạ | Repo chưa trust: nhờ user mở repo bằng Claude Code một lần. |
| Worker agy kẹt khởi động hay lệch tài khoản | `references/antigravity.md`. |
| Thao tác setup một lần agent không tự vượt được (login, trust) | Báo user ngay, một dòng. |

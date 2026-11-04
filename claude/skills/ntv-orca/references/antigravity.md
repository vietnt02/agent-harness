# Antigravity (`agy`) — Chọn model, spawn worker và gỡ lỗi

`agy` chạy chế độ **Chat** trong Orca (cả phiên Coordinator mở tay lẫn `worker-start --agent antigravity`). Cấu hình máy, đường dẫn runtime, symlink và hook bridge: `~/.claude/knowledge/orca.md` § Antigravity.

## Điều Coordinator phải biết về runtime Chat

- **Tách biệt với CLI:** mỗi phiên chat chạy `agy_acp_server` riêng của Orca. Thư mục cấu hình của runtime phải trỏ về cấu hình chung để nạp `AGENTS.md`, skills và hook (`~/.claude/knowledge/orca.md`; hook `worker-start-receipt` tự kiểm khi spawn).
- **Giới hạn lệnh:** lệnh foreground tự cắt ở 600 giây; bước dài hơn phải chạy nền và ghi log.
- **Kênh điều phối:** dùng `orca orchestration` (`SKILL.md` § 3); worker chat từ chối `orca terminal *`.
- **Context thực tế nhỏ hơn API gốc:** Flash 256K, Argon 1M. Gần đầy thì `agy` tự nén mà không báo lỗi — chia task nhỏ theo `SKILL.md` § 2.

## Chọn model và Spawn Worker

- **Phân vai (`SKILL.md` § 2, § 4):**
  - Worker và Checker: `gemini-flash` (`--effort high`); worker research: `gemini-argon` (`--effort high`).
  - Reviewer mặc định và Coordinator (khi user mở trực tiếp): `gemini-argon` (`--effort high`).
  - Không dùng model Claude qua `agy`. Luôn ghi kèm tên agent (`agy gemini-3.8-flash high`) trong manifest, spec và báo cáo để tránh nhầm quota với agent khác.
- **Truyền đủ `--model` và `--effort`:** bỏ trống `--model` sẽ lấy model của Coordinator trong settings:
  ```bash
  orca orchestration worker-start --agent antigravity --model <slug trần> --effort <mức> ...
  ```
- **Tra slug và effort:** chạy `agy models` lúc dispatch (`<slug>\t<tên>`). Bỏ đuôi `-low|-medium|-high` ra **slug trần** cho `--model`; các đuôi hiện có của model là các mức `--effort` hợp lệ (`gemini-4-argon`, `gemini-3.8-flash`: `low`/`medium`/`high`; `gpt-oss-120b`: `medium`). Không truyền slug còn đuôi vào `--model`. Sau spawn, so `launch.effective` với `launch.requested` (`SKILL.md` § 2).

## Quyền thực thi và Policy Guardian

- Worker chạy không người trông nên `toolPermission` phải là `always-proceed` (`~/.claude/knowledge/orca.md`). Không dùng `proceed-in-sandbox` (không có mạng, lệnh mạng chờ người bấm) hay `--dangerously-skip-permissions` (mất cổng hỏi khi ghi ngoài workspace).
- **Policy Guardian:** LLM chấm từng lệnh, chặn gửi dữ liệu ra ngoài, cài package lạ, đọc `.env`/SSH key dù user đã duyệt.
- **Phải nói rõ trong spec — câu chèn sẵn vào `--spec` cho mọi worker `agy`:**

      Lệnh bị chặn (do permission hoặc Policy Guardian) thì giữ nguyên thay đổi và báo coordinator qua ask, kèm lệnh và lý do bị chặn; không tìm cách lách.

## Chẩn đoán sự cố (Triệu chứng → Làm gì)

| Triệu chứng | Làm gì |
|---|---|
| `requires --effort (available: ...)` | Slug trần thiếu `--effort`; truyền thêm `--effort <mức>` hợp lệ theo `agy models`. |
| `conflicts with --effort=<mức>` hoặc `not recognized as a known model` | Đã truyền slug kèm đuôi effort hoặc chuỗi lạ vào `--model`; đổi sang slug trần kèm `--effort`. |
| `has no "<mức>" effort` | Model không có mức đó (`xhigh`/`max` không có trên `agy`); tra lại đuôi trong `agy models`. |
| `plan model not specified`, `outcome_unknown` hoặc `turn_start_unobserved` | Spec vào trước khi `agy` đăng nhập xong hoặc sai cờ model. Kiểm cờ; nếu đúng thì `worker-abandon --dispatch <id>` rồi `worker-start --task <task> --retry-of <id>` kèm `--worktree`, `--agent` (`SKILL.md` § 6). |
| `lastError: The native Antigravity account changed…` | Lệch tài khoản giữa vault Orca và `agy`. Khởi động qua shell trống: `orca terminal create --worktree path:<wt> --title <w> --json` → `orca terminal send --terminal <h> --text "agy --model <slug> --effort <mức>" --enter` → `orca terminal read --terminal <h>` (hỏi trust thư mục thì gửi `--enter`; chờ dòng email + gói) → `orca orchestration worker-start --spec … --terminal <h> --worktree path:<wt>`. Xong việc tự `orca terminal close` sau `worker-release`. |
| Worker đứng chờ duyệt hoặc bị Policy Guardian chặn | Kiểm `toolPermission` trong `~/.claude/knowledge/orca.md`; nếu chạm ngoài workspace hoặc vướng Policy Guardian thì sửa phạm vi spec. |

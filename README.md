# agent-harness

Bộ cấu hình và harness dùng chung cho Claude Code và Antigravity (`agy`), hỗ trợ thiết lập môi trường phát triển nhất quán giữa các thành viên.

## Yêu cầu

- **Bắt buộc:**
  - Claude Code
  - Node.js (>= 18)
- **Tuỳ chọn:**
  - Antigravity (`agy`)
  - Orca multi-agent IDE

## Cài đặt

1. Clone repo:
   ```bash
   git clone <repo-url> agent-harness
   cd agent-harness
   ```

### Trên macOS / Linux
2. Chạy thử trước để xem các thay đổi dự kiến (không tác động hệ thống):
   ```bash
   ./install.sh --dry-run
   ```
3. Chạy cài đặt chính thức:
   ```bash
   ./install.sh
   ```
   *(Hỗ trợ tuỳ chọn `--home <dir>` nếu muốn cài đặt vào thư mục tuỳ chỉnh thay vì `$HOME`)*

### Trên Windows
- **Yêu cầu:** Node.js >= 18, Git for Windows (khuyến nghị), bật Developer Mode (Settings → System → For developers) để tạo symlink không cần quyền Administrator.
- **Lệnh cài đặt:**
   ```cmd
   node install.cjs --dry-run
   node install.cjs
   ```
   *(Hỗ trợ tuỳ chọn `--home <dir>` nếu muốn cài đặt vào thư mục tuỳ chỉnh thay vì `%USERPROFILE%`)*
- Trên Windows settings ghi hook dạng exec (command + args) nên không phụ thuộc Git Bash.

## Cập nhật

- Khi repo có thay đổi nội dung file: chỉ cần chạy `git pull`. Do các file được liên kết bằng symlink nên các thay đổi sẽ có hiệu lực ngay lập tức.
- Khi repo có thêm file mới hoặc thư mục skill mới: chạy lại `./install.sh` (trên Windows: `node install.cjs`) để tạo symlink cho các item mới.

## Gỡ bỏ / Khôi phục

- Trước khi ghi đè hoặc thay thế bất kỳ file/thư mục nào đã tồn tại, bộ cài sẽ tự động chuyển bản cũ vào thư mục sao lưu:
  `~/.claude/backups/harness-install-<YYYYmmdd-HHMMSS>/` (trên Windows: `%USERPROFILE%\.claude\backups\harness-install-<YYYYmmdd-HHMMSS>\`)
- Để khôi phục lại trạng thái trước khi cài đặt, chuyển các file tương ứng từ thư mục sao lưu về vị trí ban đầu trong `~/.claude/` hoặc `~/.gemini/config/` (hoặc `%USERPROFILE%\.claude\` và `%USERPROFILE%\.gemini\config\`).

## Các bước sau khi cài đặt

Điền thông tin cá nhân vào 3 file trong `~/.claude/rules/mine/` (đã được tạo từ template):
1. `~/.claude/rules/mine/identities.md`: Cấu hình tài khoản GitHub / GitLab tương ứng theo từng đường dẫn repo.
2. `~/.claude/rules/mine/user-profile.md`: Thông tin cá nhân, vai trò, quyền hạn và quy tắc máy tính của bạn.
3. `~/.claude/rules/mine/knowledge-index.md`: Chỉ mục kiến thức khi cần kích hoạt các file trong `~/.claude/knowledge/`.

## Các thành phần KHÔNG có trong repo

Repo này chủ động loại trừ các thành phần mang tính nội bộ hoặc phụ thuộc riêng:
- Bộ công cụ AgentKit (`ak-*` và các hook liên quan của nó).
- Các skill riêng của Orca và skill `ntv-orca`.
- File `AGENTS.md` toàn cục của Antigravity (người dùng tự tạo riêng tại `~/.gemini/config/AGENTS.md`).
- Cấu hình thanh trạng thái (statusline).

## Giới hạn đã biết

- **Bridge Antigravity:** Bridge dùng 3 thư viện của AgentKit (`privacy-checker.cjs`, `scout-checker.cjs`, `secret-keywords.cjs`) cho các guard bảo vệ privacy, scout và secret. Nếu thiếu các file này trong `~/.claude/hooks/lib/`, các guard tương ứng sẽ không chạy.
- **Tài liệu tham chiếu:** `CLAUDE.md` và một số skill có nhắc tới `ntv-orca` và thư mục `knowledge/` mà repo hiện không đính kèm.
- **Kiểm thử bridge fixtures:** Chạy fixture bridge bằng lệnh:
  ```bash
  node ~/.gemini/config/bridge-fixtures/run.cjs
  ```
  Riêng ca umbrella yêu cầu file cấu hình `~/.gemini/config/bridge-fixtures/local.json` chứa `{"napHook": "<đường dẫn>"}`.

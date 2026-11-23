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

Điền thông tin cá nhân vào 4 file (đã được tạo từ template; cài lại không ghi đè):
1. `~/.claude/rules/mine/identities.md`: Cấu hình tài khoản GitHub / GitLab tương ứng theo từng đường dẫn repo.
2. `~/.claude/rules/mine/user-profile.md`: Thông tin cá nhân, vai trò, quyền hạn và quy tắc máy tính của bạn.
3. `~/.claude/rules/mine/knowledge-index.md`: Chỉ mục kiến thức khi cần kích hoạt các file trong `~/.claude/knowledge/`.
4. `~/.gemini/config/GEMINI.md`: Phần riêng của agy (bạn là ai, bảng tài khoản, chỉ mục knowledge). agy nạp file này cùng `~/.gemini/config/AGENTS.md`, là rule chung được symlink từ `agy/AGENTS.md` của repo. Máy đã có một `~/.gemini/config/AGENTS.md` tự viết: bộ cài chuyển nó vào thư mục sao lưu, nên chép ngay phần riêng của bạn (bạn là ai, bảng tài khoản, chỉ mục knowledge) từ bản sao lưu sang `GEMINI.md`; tới lúc đó agy chạy với bảng tài khoản để trống.

### Máy mới: các bước agy phải làm tay

Bộ cài không làm được các bước dưới; thiếu bước nào thì worker agy không chạy được khi không có người:
- [ ] Skill Orca cho agy: `orca skills install --skill orca-cli --skill orchestration`, rồi kiểm `~/.gemini/config/skills/` có `orchestration` và `orca-cli`.
- [ ] Hook trạng thái Orca cho agy: `orca agent hooks on`, rồi `orca agent hooks status` báo antigravity đã cài và `~/.gemini/config/hooks.json` có khối `orca-status`.
- [ ] Trong `~/.gemini/antigravity-cli/settings.json`, đặt `toolPermission: "always-proceed"` và `artifactReviewPolicy: "always-proceed"`; thiếu khoá sau thì plan của worker chờ người duyệt.
- [ ] Ca umbrella của `agy/bridge-fixtures/run.cjs` cần `~/.gemini/config/bridge-fixtures/local.json` chứa `{"napHook": "<đường dẫn>"}`.
- [ ] Mở agy một lần và tắt thẻ "Introducing <model>" (Esc) trước khi giao worker; thẻ này có thể làm `worker-start` báo `agent_prompt_blocked`.
- [ ] Statusline (không có trong repo) phải tự chứa, không `require` file nào ngoài nó. Orca chỉ coi agy là sẵn sàng khi dưới ô nhập có 1–3 dòng status, không dòng nào chứa `──`, `esc to cancel` hay `for shortcuts`, và không dòng nào có dạng `<model> · low|medium|high`.
- [ ] Thư viện AgentKit cho bridge: xem mục **Giới hạn đã biết**; thiếu thì 3 guard privacy, scout, secret của agy không chạy.

## Các thành phần KHÔNG có trong repo

Repo này chủ động loại trừ các thành phần mang tính nội bộ hoặc phụ thuộc riêng:
- Bộ công cụ AgentKit (`ak-*` và các hook liên quan của nó).
- Các skill riêng của Orca (`orchestration`, `orca-cli`; cài bằng lệnh ở **Máy mới: các bước agy phải làm tay**).
- Phần riêng của người dùng cho Antigravity: `~/.gemini/config/GEMINI.md`, tạo từ `templates/agy-mine/GEMINI.md` (rule chung `agy/AGENTS.md` thì có trong repo).
- Cấu hình thanh trạng thái (statusline).

## Giới hạn đã biết

- **Bridge Antigravity:** Bridge dùng 3 thư viện của AgentKit (`privacy-checker.cjs`, `scout-checker.cjs`, `secret-keywords.cjs`) cho các guard bảo vệ privacy, scout và secret. Nếu thiếu các file này trong `~/.claude/hooks/lib/`, các guard tương ứng sẽ không chạy.
- **Tài liệu tham chiếu:** `CLAUDE.md` và một số skill có nhắc tới thư mục `~/.claude/knowledge/` (vd `knowledge/orca.md`: RAM, cap worker, Settings Orca, cấu hình agy của máy) mà repo không đính kèm; mỗi máy tự viết.
- **Kiểm thử bridge fixtures:** Chạy fixture bridge bằng lệnh:
  ```bash
  node ~/.gemini/config/bridge-fixtures/run.cjs
  ```
  Riêng ca umbrella yêu cầu file cấu hình `~/.gemini/config/bridge-fixtures/local.json` chứa `{"napHook": "<đường dẫn>"}`.
  Bridge ghi dạng khoá (không ghi giá trị) của mỗi payload thật vào `~/.gemini/config/bridge-fixtures/seen-shapes.json`;
  `run.cjs` chỉ ghi `tested-versions.json` khi mọi payload thấy được từ lúc cài bản agy hiện tại có dạng mà
  `payloads.json` phát lại (exit 3: chưa thấy payload nào của bản mới). Hook `worker-start-receipt` tự chạy
  `run.cjs` khi agy đổi bản và chỉ báo khi FAIL.

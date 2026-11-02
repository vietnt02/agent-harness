# Antigravity (`agy`) — Chat UI cho cả Coordinator lẫn worker

agy chạy **Chat** trong Orca (Settings → Agents → Antigravity: Chat; user chốt), cả phiên user mở tay
lẫn worker `worker-start --agent antigravity`. Đường TUI (terminal) còn ở cuối file, chỉ dùng khi cần
thứ chat không có. Đường dẫn, bản và cấu hình agy trên máy đang dùng: `~/.claude/knowledge/orca.md`
§ Antigravity.

## Chat chạy runtime agy của Orca, không phải `agy` trên máy

Mỗi phiên chat là `agy_acp_server` do Orca mang theo, bản có thể khác `agy --version` trên máy, với
`GEMINI_HOME` do Orca chọn. Hệ quả:

- **Harness:** runtime chỉ đọc `$GEMINI_HOME/config`. Muốn chat nạp `AGENTS.md` toàn cục, skills và
  hook thì `$GEMINI_HOME/config` phải trỏ về `~/.gemini/config`. Orca không xoá thư mục đó, nhưng bản
  sau hay đổi tài khoản có thể dời `GEMINI_HOME`.
- **Hook trong chat** đọc cùng `hooks.json`. Payload chat khác CLI ở hai chỗ: tham số tool tới khi
  `AbsolutePath` khi `absolute_path`, và `transcriptPath` là `conversations/<id>.db` (SQLite), nên
  nhận diện worker phải đọc `brain/<id>/.system_generated/logs/transcript.jsonl`. Payload chat không
  có `artifactDirectoryPath` riêng cho từng hội thoại: state hook đặt theo `conversationId`.
- **File rác:** runtime ghi `skills/system/run-workflow/SKILL.md` vào mọi workspace nó chạy; ignore
  toàn cục.
- **Model thật:** lấy ở `launch.effective` của receipt và DB hội thoại của chat. Log `cli-*.log` mở
  cùng lúc spawn là của một process `agy` CLI khác, không đọc model hay hook của worker chat từ đó.
- **Lệnh foreground bị cắt ở 600 s**; bước dài hơn thì chạy nền và ghi log.
- **Skill `orchestration` cho agy** phải nằm trong `~/.gemini/config/skills/`; worker chat gọi `ask`,
  `worker_done` nhờ preamble của Orca.
- Kênh với worker chat là lệnh orchestration (`SKILL.md` Rule 13); `orca terminal *` bị từ chối.

## Spawn Worker

`worker-start --agent antigravity --model <slug trần> --effort <mức>`. Orca dựng thành
`agy --model <id> --effort <mức> --prompt-interactive "<spec>"`.

**Tra slug:** `agy models` in `<slug>\t<tên hiển thị>`, slug mang đuôi `-low|-medium|-high`.
Bỏ đuôi ra slug trần. Các đuôi một model có chính là các effort hợp lệ của nó; đừng suy từ
model khác (`gpt-oss-120b` chỉ có `medium`, còn `gemini-4-argon` và `gemini-3.8-flash` có đủ
`low`/`medium`/`high`). Lấy bản mới nhất của dòng lúc dispatch, đừng chép số version từ file này.

**Phân vai Gemini qua `agy`:**
- **Worker / Checker qua Orca dùng `gemini-3.8-flash`** (`--effort high`); không dùng model Claude
  của `agy` (`SKILL.md` Rule 18 § Thứ tự agent và model). Reviewer mặc định: `ntv-implement` § Verify.
- **`gemini-4-argon` (`--effort high`) dùng cho Coordinator** khi người dùng làm việc trực tiếp.
- Báo cáo, manifest và spec luôn gọi model qua `agy` kèm tên agent (`agy gemini-3.8-flash high`,
  `agy claude-sonnet-5-5 high`), không gọi trống "Sonnet": user đọc thành Claude Sonnet của
  Claude Code, tài khoản và quota khác.

**Mặc định `--effort high`.** Lệnh spawn worker chuẩn:

```
--agent antigravity --model gemini-3.8-flash --effort high
```

Model chỉ có một mức thì truyền đúng mức đó (`gpt-oss-120b --effort medium`). Luôn slug trần
kèm `--effort`, không truyền slug có đuôi: `--model gemini-3.8-flash-high` báo `not recognized as a
known model … Ignoring the flag` lúc khởi động, rồi lượt đầu chết với `failed to construct executor:
plan model not specified`: worker đứng im tới khi có người gõ `/model`.

**Argon:** `--model gemini-4-argon --effort high` → log có `label="Gemini 4 Argon (High)"`. Thiếu
`--effort` thì không có dòng `Propagating…`, log chỉ `Model ID gemini-4-argon not in local config …
resolved via default`, và worker chạy Medium. Bản `agy` cũ bỏ qua cờ (`--effort is not supported for
model "gemini-4-argon"`), mức do alias quyết. Spec, manifest và session note không ghi effort theo
argv; ghi theo dòng `Propagating…` (§ Kiểm và vận hành), tìm file log theo pid của worker
(`Starting language server process with pid <pid>`), không lấy file mới nhất.

**Fallback (chỉ đường TUI): khởi động qua shell trống** (khi `worker-start --agent antigravity` báo lỗi
`native Antigravity account changed`):

```bash
orca terminal create --worktree path:<wt> --title <w> --json          # không --command
orca terminal send --terminal <h> --text "agy --model <slug> --effort <mức>" --enter
orca terminal read --terminal <h>     # màn trust (dưới) thì gửi Enter; chờ thấy dòng email + gói: agy đã đăng nhập xong
orca orchestration worker-start --spec … --terminal <h> --worktree path:<wt>
```

Màn "Do you trust the contents of this project?" với worktree coordinator tạo cho worker: coordinator tự
chọn "Yes, I trust this folder" (mục được chọn sẵn) bằng `orca terminal send --terminal <h> --enter`, rồi
đọc lại, không dừng hỏi user; worktree chỉ vào `trustedWorkspaces` của settings agy sau lần trust đầu.

Đường này không qua bước Orca kiểm tài khoản, và tránh luôn lỗi spec tới trước khi `agy` đăng nhập
xong. `worker-release` để lại terminal: coordinator tự `orca terminal close` khi xong.

**Bắt buộc truyền `--model` khi spawn worker:** không truyền thì `agy` lấy khoá `"model"` trong
settings của nó, thường đặt cho phiên Coordinator chứ không cho worker.

## Lỗi do `agy` trả

Orca chỉ biết danh sách cố định low/medium/high cho antigravity, nên không chặn trước. Gặp lỗi
thì sửa cờ, đừng đổi model:

| Lỗi | Nguyên nhân |
|---|---|
| `requires --effort (available: ...)` | slug trần thiếu `--effort` |
| `conflicts with --effort=<mức>` | đuôi slug khác `--effort` |
| `has no "<mức>" effort (available: ...)` | model không có mức đó; `xhigh`/`max` luôn rơi vào đây dù `agy --help` liệt kê |
| `not recognized as a known model`, rồi `plan model not specified` | chuỗi lạ, kể cả slug có đuôi effort; worker không chạy lượt nào, Task nằm im |
| `plan model not specified` dù cờ đúng; Orca báo `outcome_unknown` / `turn_start_unobserved` | spec tới trước khi `agy` đăng nhập xong: màn hình đã khớp `composer_ready` nên Orca gửi spec sớm vài giây. Nhận: trong `cli-*.log`, dòng `plan model` sớm hơn dòng `Propagating selected model override`. Gỡ (bằng chứng là dòng log đó): `worker-abandon`, rồi `worker-start --task <cũ> --terminal <cùng terminal> --retry-of <dispatch cũ>`, không cần worktree mới |
| `--effort is not supported for model` | bản `agy` cũ: cờ bị bỏ qua, effort theo alias (đoạn Argon ở trên) |
| `agent_readiness` timeout lặp lại | 4 dòng cuối màn hình không khớp `composer_ready` (§ Orca nhận diện sẵn sàng) |
| `lastError: The native Antigravity account changed. Select the account again in Accounts…` | Orca so tài khoản trong vault của nó với đăng nhập `agy` trên máy, lệch thì chặn mọi lần Orca tự khởi động `agy` (`--agent antigravity` và cả `terminal create --command agy`); mỗi `agy` mới tự đăng nhập lại nên vault lại lệch. Không nhờ user bấm Select: khởi động qua shell trống (§ Spawn Worker) |

## Kiểm và vận hành

- **Model thật (TUI; chat: § Chat chạy runtime agy của Orca):** ngoài `launch.effective`, mỗi process
  `agy` ghi một file log `cli-<giờ>.log` có dòng
  `Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"`.
  Tìm file theo giờ spawn. Model và effort thật chỉ lấy từ dòng này, không tin argv hay spec.
- **Process và resume:** worker chat là `agy_acp_server`; worker TUI là `agy`, thêm nó vào pattern
  `ps aux | grep -E` của Rule 6 và Rule 10. Orca resume bằng `agy --conversation <id>`, không phải
  `--resume`.
- **Context thật qua `agy`** nhỏ hơn API của Google: Flash và Claude 256K, Gemini 3.1 Pro 128K,
  GPT-OSS 80K; Argon 1M (`context_window.context_window_size` trong payload statusLine; trường
  `context_window_metadata.max_context_tokens` trong DB hội thoại). Gần đầy thì `agy` tự nén hội
  thoại, không báo lỗi. Hệ quả cho cỡ task: `SKILL.md` Rule 18 § Chọn model theo loại việc.

## Orca nhận diện sẵn sàng (`composer_ready`; chỉ đường TUI)

Rule của antigravity trong `Orca.app/Contents/Resources/app.asar` đòi 4 dòng cuối màn hình khớp lần
lượt `^─{8,}$`, `^>$|^>\s+[a-z][a-z-]*\s+mode:\s`, `^─{8,}$`, `^\? for shortcuts` (ignoreCase), kèm
`requiresQuiet: true`. Rule đếm 4 dòng **không trống** cuối và dòng 4 chỉ neo đầu dòng: một statusline
tự chế thay dòng `? for shortcuts`, hay thêm dòng dưới nó, làm `worker-start` timeout `agent_readiness`
liên tục. Statusline tự chế phải gộp thành **một dòng** bắt đầu bằng `? for shortcuts`.

- Timeout `agent_readiness` → đọc rule này trong `app.asar` và `terminal read --screen` trước mọi giả
  thuyết; không nhờ user bấm phím thử.
- Ô nhập khớp rule không có nghĩa model đã nạp: xem hàng `plan model not specified` ở bảng lỗi.
- `outcome_unknown` với `agy` → đọc màn hình ngay, không chờ bộ chờ stale 20 phút: lỗi đỏ nằm trên
  màn hình mà Orca không đọc ra.
- Rủi ro còn lại: `agy` gốc đổi dòng gợi ý thành `esc to cancel` khi đang chạy lượt; statusline luôn
  in `? for shortcuts` thì giữa lượt chỉ còn `requiresQuiet` cho Orca biết worker bận.

## Worker TUI

Áp cho worker chạy trong terminal: agy hay Claude/Codex bị ép TUI (`SKILL.md` phần đầu). Worker chat
không nhận các lệnh `orca terminal *`. Kênh chính vẫn là lệnh orchestration (`SKILL.md` Rule 13);
mục này chỉ cho lúc cần gõ thẳng vào terminal.

### Gửi tin qua `terminal send`

**Luôn có `--enter`**: thiếu thì chữ nằm im trong prompt. **`--text` phải NGẮN, mệnh lệnh ở câu
ĐẦU.** Tin ~10 dòng bị cắt mất phần đầu — worker chỉ nhận được đuôi, mất đúng dòng mệnh lệnh, nên
hỏi lại. Nội dung dài → mail `orchestration send`, hoặc file dưới đây.

**Khối nhiều dòng qua `terminal send` thì mất** ở TUI Claude/codex (antigravity nhận đủ). Ghi ra một
file cố định cho mỗi worker, `<worktree>/.orca-msg.md`, **ghi đè** (`>`) mỗi lần gửi, chỉ sau khi
`orca terminal read` xác nhận worker đã đọc tin trước; lần đầu ở một repo thêm nó vào exclude cục bộ:
`f=$(git -C <worktree> rev-parse --git-path info/exclude); grep -qx '.orca-msg.md' "$f" || echo '.orca-msg.md' >> "$f"`.
Gửi `terminal send --enter --text "Đọc <worktree>/.orca-msg.md rồi làm theo."`; `rm -f` file khi release.

**Sau `terminal send --wait-submit <giây>`: đọc `result.send.prompt`.** Có stage sau
`input_accepted` thì tin đã vào lượt chạy. `observation: unsupported` (antigravity) thì receipt chỉ
nói đã gõ được chữ: `orca terminal read` xác nhận agent đã chạy rồi mới coi là đã gửi.

**Canh idle (`SKILL.md` Rule 20):** đọc màn hình, codex không còn `• Working`, Claude không còn
`esc to interrupt`, agy xem § Orca nhận diện sẵn sàng.

### Phím điều khiển: `ESC` được, phím khác thì không

**`ESC` được phép** (user chốt: lỡ ngắt worker thì gửi tin cho nó làm tiếp). Tin của coordinator có
thể nằm trong hàng đợi của worker, và mỗi CLI xử lý hàng đợi một kiểu, có CLI chỉ nhận tin mới khi
xong lượt. Cần tin tới ngay (user đã quyết dừng, đổi hướng, sửa spec) thì gửi `ESC` rồi gửi tin:

```bash
orca terminal send --terminal <h> --text $'\x1b'
orca terminal send --terminal <h> --text "<tin>" --enter
```

`ESC` ngắt lượt đang chạy; lỡ ngắt việc không định ngắt thì gửi `tiếp tục` kèm `--enter`. Đóng hẳn
worker theo quyết định của user thì dùng `worker-stop --dispatch <id>`.

**Cấm hai phím đã gây hỏng thật, và mọi phím chưa biết tác dụng:**

- `ESC[Z` (Shift+Tab) — vòng cycle của codex là Default ↔ **Plan mode**, không
  có full-auto. Worker rơi vào chế độ *cấm sửa file*.
- `Ctrl+C` — **thoát hẳn codex** (`Shutting down...`). Mất trọn session; việc chưa
  commit còn trong worktree, nhưng phải spawn agent mới — trả lại tiền nạp harness
  (`SKILL.md` Rule 8).

Cần đổi trạng thái TUI thì dùng lệnh của chính TUI đó (`/permissions`, `/model`), không dò
bằng phím.

**Khi `terminal send` trả `agent_prompt_blocked`:** đọc `orca terminal read`
trước, vì có hai ca. Worker **đang chạy** (spinner, counter tăng) thì đó là trạng
thái bình thường — đặt vòng retry chạy nền thay vì gửi tay:
`until orca terminal send --terminal <h> --enter --text "$(cat msg.txt)" --json | grep -q '"ok": true'; do sleep 20; done`.
Prompt **trông rảnh** mà vẫn bị chặn thì đó là Orca từ chối, không phải TUI kẹt.
Đừng bắn thêm phím để "gỡ". Đi đường dispatch của `SKILL.md` Rule 15 —
`worker-abandon` → `task-update --status ready --run <run sở hữu>` → `worker-start --terminal <cũ>`.
Nếu bước đó trả `failed / stage: agent_readiness` thì agent thật sự đã chết:
spawn agent mới **trong đúng worktree đó** (`--worktree path:<...>`), file vẫn
còn, và spec tiếp nối phải nói rõ *đọc `git status` / `git diff` rồi làm tiếp*,
đừng làm lại từ đầu.

## Quyền và Policy Guardian

Worker không có ai trông, nên không được dừng chờ người bấm: `toolPermission` của agy phải là
`always-proceed` (giá trị trên máy đang dùng: `~/.claude/knowledge/orca.md`). Đây là setting global,
nên phiên `agy` user tự mở cũng không hỏi. Mỗi lần khởi động, log ghi `CLI settings initialized: ...
toolPermission=<mode>`. Với `always-proceed`: ghi file, `curl`, commit, `git push` qua SSH (kèm hook
`pre-push`) đều chạy không hỏi.

| `toolPermission` | Hành vi |
|---|---|
| `request-review` (mặc định của `agy`) | dừng trước mỗi lần ghi file để duyệt diff; lệnh terminal phải xin duyệt |
| `strict` | duyệt chặt nhất |
| `proceed-in-sandbox` | tự chạy lệnh trong sandbox; ra khỏi sandbox cần **người bấm** ("Requires manual user approval") |
| `always-proceed` | tự chạy hết, kể cả MCP và đọc trang web; vẫn hỏi khi ghi file ngoài workspace |

- **Không dùng `proceed-in-sandbox` cho worker:** sandbox không có mạng, nên `npm install`,
  `git push`, `gh`, `curl` đều phải bypass, mà bypass thì phải chờ người bấm.
- **Không dùng `--dangerously-skip-permissions`:** cờ này bỏ luôn lần hỏi khi ghi ra ngoài
  workspace. Worker đứng ở lần hỏi đó nghĩa là spec sai, cần sửa spec.
- **`--mode` (`default` → `accept-edits` → `plan`) là trục khác**, worker để mặc định.
- **Policy Guardian:** một LLM chấm từng tool call APPROVE hoặc DENY, có quyền chặn cả việc
  user đã duyệt. Luôn cho qua lệnh đọc local (`ls`, `cat`, `git status/log/diff`). Kiểm luồng
  dữ liệu của `git push`/`git pull` theo URL remote. Chặn gửi dữ liệu ra ngoài, chạy code
  tải về, cài package lạ, đọc `.env`/SSH key. Log có tag `policy_guardian` mà không có dòng
  `[PolicyGuardian]` nào thì nó chưa chấm lệnh nào.

**Phải nói rõ trong spec — câu chèn sẵn vào `--spec` cho mọi worker `agy`:**

    Lệnh bị chặn (do permission hoặc Policy Guardian) thì giữ nguyên thay đổi và báo coordinator qua ask, kèm lệnh và lý do bị chặn; không tìm cách lách.

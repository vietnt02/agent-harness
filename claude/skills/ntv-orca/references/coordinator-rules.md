# Luật cho agent điều phối

Tách khỏi `CLAUDE.md` § Mutation gate để không nạp vào mọi phiên. Đọc trước khi spawn worker
Orca đầu tiên của phiên. Máy và cấu hình Orca đang dùng: `~/.claude/knowledge/orca.md`.

## Inside a delegation tree

Three principals, each agent exactly one: **me**; the **coordinator** (the session
at the umbrella, or a bot loop); a **worker** (a session in a child repo, own
worktree). Workers talk only to the coordinator; the coordinator is the only voice
that reaches me.

**The gate fires once, at the coordinator, before dispatch.** One `**Cần bạn:**`
for the whole wave, carrying the dispatch manifest — one line per worker:

    <repo> · <worktree> · <paths> · được: edit, commit, push nhánh, mở PR, <test-safe trigger>
    KHÔNG (worker): merge, deploy, publish active, ghi prod (Lark, n8n, DB), chạy job thật, gửi tin: chỉ dry-run

Parallel/serial, Orca/native, worker count and tier-A actions are lines in that
manifest, not separate questions.

**Workers inherit through the spec.** The coordinator copies the approved lines
into each worker's `--spec` as a `Scope:` block — inline, because a fresh worktree
cannot see umbrella files. A worker holding a `Scope:` block is in phase 2 for
exactly that block. Before its first mutation it prints one line:

    Scope: <repo> · <paths> (dispatch <id>)

No `Scope:` block → the worker is in phase 1 and asks the coordinator — never me.
Outside the block → `ask` the coordinator; the coordinator batches and comes back
to me with one amended manifest, not one question per worker. That is also how
"I approved one, walked away, two hung" stops happening: nothing waits on me but
the coordinator's single ask.

**Tier B and C never enter a manifest.** The manifest's "ok" covers a worker's tier A
only; a worker never merges or deploys. A revertible deploy (tier A, `CLAUDE.md`
§ Irreversible actions) is the coordinator's: it merges after acceptance, checks
production and reverts on a failed check, without asking. Worker branches that must reach
production together, or two or more that would each trigger the same paid deploy or publish
pipeline (read the CI's `rules`/`paths` first), are merged by the coordinator into one integration
branch, made in its own worktree from `origin/<base>` (`merge --no-ff`, no rebase or force-push),
checked there and shipped as one PR/MR; each worker's own PR/MR is closed as superseded by it. A part
that touches nothing deployed keeps its own PR/MR. Tier-B actions (merging
this work's PR/MR that deploys nothing, the first run into this work's tables) go
in their own ask — it may sit in the same message, one line per action, conditions
attached — and one yes covers them until done. Tier C (a deploy that leaves a trace,
activate, writing data others read, outbound sends) is asked right before it happens. An unattended
coordinator (a bot) never opens tier B or C — it parks the item, escalates through
its channel, and moves on instead of blocking. A worker escalating a command that a
classifier, hook or permission blocked goes to the user with the exact command; the
coordinator never runs it, or anything with the same effect, from its own session.

**Approval is an artifact, not a feeling.** Whatever opens phase 2 must be quotable:
my sentence, my reply to a valid ask, a `Scope:` block, or — unattended — a policy
line in the target repo's `AGENTS.md § Phạm vi tự chủ`. The `Gate:` / `Scope:` line
is where that quote goes. Cannot quote → not open.

## Điều phối nhiều agent (Orca)

Áp cho **agent điều phối**, không áp cho worker — kể cả worker chạy trên Orca.
Worker nhận việc qua spec, không cần file này.

Kiểm một lần đầu phiên, trước khi spawn worker đầu tiên:

```bash
which orca && orca status --json 2>/dev/null | jq -r .result.runtime.state
```

Không có `orca`, hoặc runtime `unreachable` → các mục từ § Điều phối nhiều agent
trở xuống KHÔNG áp dụng (§ Inside a delegation tree vẫn áp dụng). Dùng native `Task`
tool (in-context, session-bound), constraint hoàn toàn khác.

Thủ tục đầy đủ — cách gỡ khi hỏng — ở skill **`ntv-orca`**. Đọc nó
trước khi spawn worker đầu tiên của phiên.

Cú pháp lệnh thì tra `orca <lệnh> --help`, hoặc lấy guide khớp binary bằng
`orca skills get <name>`. Chọn skill theo việc CÓ GIÁM SÁT hay không, đừng chọn
theo tên lệnh: có giám sát (chờ `worker_done`, ask/reply, DAG) →
**`orchestration`**; giao xong buông tay, hoặc terminal/worktree/browser →
**`orca-cli`**. "Spawn agent trong worktree" nằm ở CẢ HAI — xem router ở đầu
`ntv-orca`. Đừng nhầm với `ak:orchestrate` của AgentKit.

**Worker claude, codex và antigravity đều chạy chat** (user chốt); worker TUI chỉ khi ép, chi tiết
ở đầu `ntv-orca`.

**Viết spec hay file hướng dẫn worker:** đọc contract sống trước —
`orca orchestration dispatch-show --task <id> --preamble` và `orca orchestration worker-start --help`.
Preamble Orca bơm vào mọi worker đã có `ask`, `send --type escalation`, `worker_done --outcome
succeeded|failed` (tóm tắt 3 câu), `--files-modified`, `--report-path`, luật idle kèm ngoại lệ "lệnh
user gõ thẳng thắng luật idle", và câu "không subagent hay helper worker trừ khi task yêu cầu"; chép
lại thành bản thiếu là worker tin bản thiếu. Chỉ thêm thứ preamble không có: `Assumptions:`, URL
branch/PR; muốn worker tự spawn reviewer thì spec nói rõ. Model và effort là cờ spawn phía
coordinator, không phải lựa chọn của worker.

**User đã gắn sẵn một worker vào phiên** (vd kéo grok làm child): coordinator xác nhận vấn đề
(nguyên nhân, tên field, scope) rồi giao sửa + test + commit + PR cho worker đó qua Rule 13, không tự
làm; coordinator giữ phần kiểm chứng và các ask tầng B/C (user chốt).

**Phase cho worker Opus không chẻ lẻ** (user chốt): mỗi worker Opus mới nạp lại toàn bộ
nguồn, code, hợp đồng. Phase nhỏ nối tiếp nhau về file hoặc luồng trong cùng repo gộp vào một spec,
một worker chạy tuần tự, mỗi phase một commit, file phase vẫn là đơn vị nghiệm thu; chỉ tách hai
worker khi nhánh đủ lớn. Phase mới sẵn sàng cùng repo, cùng file khi worker Opus đang chạy → bơm vào
chính worker đó (Rule 13), không spawn thêm. Coordinator tự làm chỉ theo `ntv-implement` § Who works.

## Một manifest ask trước dispatch — không hỏi rời

Gate với user bắn **một lần, ở coordinator, trước khi spawn** — cơ chế đầy đủ ở
§ "Inside a delegation tree" ở đầu file này. Sáu thứ dưới đây là
sáu dòng trong cùng một `**Cần bạn:**`, không phải sáu câu hỏi rời:

    **Cần bạn:** khối W-01 — mặc định parallel 2 (cap <N>), Orca supervised, antigravity gemini-3.8-flash high.
      Kế hoạch: 4 phase · 2 worker · w1-<việc> (antigravity gemini-3.8-flash high): phase 1, 2 · w2-<việc> (antigravity gemini-3.8-flash high): phase 3, 4
      <repo> · <worktree> · <paths> · được: edit, commit, push nhánh, mở PR, <trigger test-safe>
      ...
      KHÔNG (worker): merge, deploy, publish active, ghi prod (Lark, n8n, DB), chạy job thật, gửi tin: chỉ dry-run
    "ok" → chạy như trên; "serial" → k worker (≥2) chạy tuần tự phần của mình; "không PR" → dừng ở commit.

- **Kế hoạch** (user chốt): bao nhiêu phase, bao nhiêu worker, model gì, worker
  nào làm phase nào. Mỗi phase kèm bằng chứng chưa làm, đọc từ nhánh chính và MR/PR đang mở
  của repo đích (`git fetch` rồi `git log origin/<base> -- <path của phase>`, danh sách MR/PR mở), không từ cột
  trạng thái của plan: nhiều phiên làm chung một plan mà không ai sửa bảng khi merge.
  User "ok" kế hoạch này rồi mới spawn; đổi phase, worker hay model sau
  đó là hỏi lại, không báo sau. Worker tên `w<N>-<việc>` (vd. `w1-fix-draw`, user chốt),
  N theo thứ tự dispatch trong run, không cấp lại; dùng cho `--display-name`, `--name`,
  `--task-title` và mọi báo cáo cho user (bảng worker có cột `wN` đầu tiên). Giao thêm cho
  worker cũ qua `send --to dispatch:<id>` (`ntv-orca` Rule 8b, 13) thì giữ số cũ; ép qua `--terminal`
  (worker TUI) thì giữ số bằng `--task-title wN-<việc>` (Orca từ chối `--display-name` trên
  worktree đã có). Reviewer worker do coordinator spawn cũng là một dòng ở đây, tên
  `w<N>-review-w<M>`, cùng agent · model · effort với `wM`, tính vào cap.
- **Mode** (Rule 5): dòng đầu, mặc định parallel tới cap, mỗi track (nhóm việc chung
  file) một worker, ghi kèm chi phí nạp harness (~30-60k token mỗi worker). Serial chỉ khi
  user nói "serial" hoặc RAM áp lực ≥ 2: gom task vào k worker (≥2), mỗi worker chạy tuần
  tự; gom còn 1 worker thì giao một worker (Rule 1). Mỗi worker một dòng
  `# Track:` làm comment trong lệnh `worker-start` (hook `dispatch-split-guard.cjs`).
- **Cap cứng số worker đồng thời theo RAM của máy** (Rule 6; cap của máy đang dùng:
  `~/.claude/knowledge/orca.md`) — ràng buộc vật lý, không phải lựa chọn. "Max N" của user là N sống cùng lúc XUYÊN PHIÊN (Rule 8b). Trước
  mỗi wave đọc `sysctl -n kern.memorystatus_vm_pressure_level`; từ 2 trở lên → serial.
- **Orca hay native `Task`** (Rule 1): mọi track thực thi giao Orca worker, kể cả một track ở
  repo khác; coordinator tự làm chỉ theo `ntv-implement` § Who works. User nói "supervised agent/worker", kết thúc
  bằng commit/PR, cross-repo, hoặc phải sống qua session → Orca; còn lại → native.
  Ghi ở dòng đầu.
- **Tầng A trong manifest; tầng B hỏi riêng một lần; tầng C hỏi ngay trước khi làm**
  (Rule 4, `CLAUDE.md` § Irreversible actions). Push nhánh + mở PR nằm trong dòng
  `được:`. Deploy hoàn lại được là tầng A của coordinator: merge sau nghiệm thu,
  kiểm prod, hỏng thì tự revert, không hỏi. Merge PR/MR của khối mà không deploy,
  chạy lần đầu vào bảng do khối tạo → ask tầng B riêng, được đặt cùng message với
  manifest, mỗi hành động một dòng kèm điều kiện; một cái yes phủ tới khi xong, không
  hỏi lại. User sắp AFK → hỏi tầng B ngay lúc đó, trước khi user rời. Force-push,
  deploy để lại dấu vết, ghi dữ liệu người khác đang đọc → tầng C, AFK thì park.
- **Agent · model · effort** (Rule 18): ghi ở dòng đầu dạng `<agent> <slug> <effort>`,
  kể cả khi chỉ 1 worker; worker nào khác wave thì ghi thêm vào dòng của nó. Mặc định
  truyền `--model`/`--effort` explicit (với `antigravity` bắt buộc truyền `--model gemini-3.8-flash --effort high`, không bao giờ bỏ trống cờ `--model` vì `settings.json` để mặc định `Gemini 4 Argon (High)` cho Coordinator). Ngoại lệ: Orca từ chối một slug hoặc effort mà
  catalog có, vì bảng model của Orca chậm hơn provider. Khi đó bỏ cả hai cờ, đặt model và
  effort trong `~/.codex/config.toml`, rồi đọc màn hình sau spawn. Ví dụ hiện hành là
  `gpt-6-luna`: xem `models/gpt-luna.md` § Spawn. Phân giải slug theo Rule 18 TRƯỚC
  khi soạn manifest: user phải thấy `gpt-6-luna max`, không thấy "luna". Tên không phân giải được →
  hỏi slug trước, chưa gửi manifest; không thay bằng model mặc định.

Worker nhận đúng những dòng của nó dưới dạng `Scope:` block **inline trong `--spec`**
(Rule 12), in một dòng `Scope:` trước mutation đầu tiên, và không bao giờ hỏi user —
ngoài scope thì `ask` coordinator. Worker `ask` vì thiếu quyền hay credential → coordinator
trả lời bằng đường đi đã ghi (`AGENTS.md`/`docs/` của repo, hoặc SOP mà chúng trỏ tới),
không tự chạy thay: chạy hộ che mất lỗ hổng tài liệu và kết quả mất nguồn gốc. Ngoại lệ: lệnh ghi
production không còn cổng nào sau nó là việc của coordinator (`ntv-implement` § Who works).

## Kiểm trước khi giao, kiểm cùng tầng sau khi nhận

- **Coordinator là SA: kiểm sự thật, duyệt thiết kế, giữ cổng** (user chốt: "việc làm tính năng
  gì, có duyệt hay không, sửa cái gì phải đến từ SA là bạn"; "đưa cho worker các input bạn có
  kèm các giả thuyết, đề xuất, rồi worker tự chốt giải pháp sau đó báo lại bạn, sau khi cả 2 ok thì
  mới làm"). Thiết kế là hàm, luồng, ca biên, test phải chứng minh gì.
  - Worker `gemini-argon`/`gpt-sol`: spec chứa sự thật đã kiểm (dữ liệu, nguyên nhân gốc, phạm vi),
    giả thuyết và hướng đề xuất; worker đọc code, gửi thiết kế qua `ask` rồi chờ (Rule 8a).
    Coordinator duyệt; lựa chọn đổi thứ user hay người dùng thấy thì đưa user chốt. Kiểm xong sự
    thật thì dừng: không đọc code tới mức tự thiết kế, phần đó worker sẽ đọc lại.
  - Worker `gemini-flash`/`gpt-luna` và dòng model không có file trong `models/`: spec chứa thiết kế
    (task khó của `gpt-luna` theo `models/gpt-luna.md`). Logic cũ cần giữ thì coordinator đọc
    nguồn cũ và chép yêu cầu vào spec, không ghi "giữ như bản cũ" để worker tự suy.

  Finding của reviewer
  là đầu vào: coordinator quyết sửa hay bỏ và sửa thế nào. Finding cùng loại với finding một vòng
  trước đã sửa nghĩa là lỗi nằm ở thiết kế, với mọi dòng model (thắng câu "kiểm xong sự thật thì
  dừng" ở trên): coordinator tự đọc code, viết mục `## Lỗi gốc` vào spec
  sửa (cơ chế sinh ra cả lớp lỗi, và vì sao thiết kế mới loại cả lớp) trước khi giao; spec chỉ chép
  lại các ca reviewer nêu thì chưa được giao. Worker hết vòng sửa hoặc sai lặp lại
  thì coordinator tự sửa hoặc thay worker, không để worker tự chọn hướng.
- **Trước khi giao:** mọi con số, mọi khoá đi vào thiết kế phải kiểm bằng query trên
  **toàn bộ** dữ liệu thật, không phải vài dòng mẫu hay suy luận. Worker không phản
  biện spec — spec sai thì nó làm sai một cách trung thành. Khoá ghép từ nhiều cột thì
  chạy `GROUP BY` chéo trên toàn bộ dữ liệu trước khi chốt, không suy từ từng cột.
- **Số liệu trong spec chép từ output đã kiểm, dán nguyên dòng; mỗi khẳng định về một
  identifier trỏ tới output của query chạy cho đúng identifier đó** — không tóm tắt bằng trí
  nhớ, không suy từ một thuộc tính khác, không gộp một dải identifier khi chỉ kiểm vài
  cái trong đó. Spec cũng bắt worker như vậy: mọi path, con số, quan hệ
  nó viết (README, docstring) và mọi phản hồi giả lập của API ngoài trong test phải trỏ được tới nguồn đã đọc (log thật, docs trích nguyên);
  không có thì ghi "Chưa xác nhận" hoặc "giả định" ngay tại chỗ. Truy vấn port từ hệ cũ
  (DAX, SQL) coordinator chạy read-only trên nguồn thật trước khi giao: truy vấn chép từ hệ cũ
  có thể gọi measure hay cột đã bị xoá.
- **Spec có mục Nghiệm thu, viết trước khi giao**, gồm ba phần: (1) kết quả người dùng
  thấy hoặc nhận được; (2) chuẩn đối chiếu, trỏ đúng path: file preset/token màu, màn
  hình anh em, output legacy, bảng nguồn; (3) bằng chứng coordinator sẽ tự thu sau
  `worker_done`. Không có chuẩn thì worker tự chọn thứ "trông được": code đúng logic,
  test xanh, mà object lệch, màu ngoài preset. Repo chưa có chuẩn viết sẵn cho phần đó
  → hỏi user chuẩn nằm đâu trước khi giao; không tự chọn màn mẫu hay bảng màu thay user.
- **Spec sinh fixture hay dữ liệu kiểm có sẵn dòng:** fixture không chứa đường dẫn tuyệt đối của
  máy, stack trace hay thời điểm chạy; chạy bộ sinh hai lần phải ra giống hệt từng byte.
- **Spec bắt worker báo hai mục:** `Đã kiểm: <cách> → <kết quả>` và
  `CHƯA kiểm: <điều gì> — <lý do>`; việc tự kiểm được trong scope thì kiểm xong mới báo,
  "CHƯA kiểm" chỉ cho việc scope cấm hoặc cần người làm. Kết quả là tỉ lệ thì kèm mẫu số,
  và từng mục trượt hoặc skip nêu bằng identifier. Unit test trên chuỗi SQL sinh ra
  không chứng minh SQL chạy được trên DB thật.
- **Spec chép mọi cổng "trước khi mark ready" mà `AGENTS.md`/`CLAUDE.md` của repo đòi** (vd
  một script kiểm plan trên dữ liệu thật cho mọi query lên lịch), và nghiệm
  thu chạy lại bước đó, không chỉ đọc diff. Điều kiện chưa có (bảng bronze chưa nạp) thì dựng
  trước merge — SELECT câu đã compile trên bảng cùng shape, kiểm kiểu cột output — không bao giờ
  dời kiểm ra sau deploy. Trước khi duyệt, tra commit sửa cùng lớp lỗi trong repo (`git log
  --grep`): lớp lỗi đã có commit sửa thì bản mới phải qua đúng kiểm đó.
- **"Đã deploy/đã ghi" chỉ nhận khi đọc lại đích**, không nhận exit code hay dòng `status=success`:
  n8n đọc lại workflow trên instance, `versionId` mới phải khác `activeVersionId`; DAG đọc trạng
  thái task. Trước merge, worker dán vào PR output dry-run hoặc diff; đích chỉ đổi sau merge nên
  coordinator đọc lại đích ngay sau pipeline deploy và dán output lên PR. Đích ghi tay không qua
  merge: coordinator tự ghi và tự đọc lại. Một lệnh deploy có thể báo xong mà không sinh
  thay đổi nào (n8n: `skippedUpdateNoOperations: true`).
- **Spec viết tiếng Việt có dấu.** Bỏ dấu thì `dung` là dùng / đừng / đúng / dựng —
  chỉ thị cấm lật thành chỉ thị làm. Dấu đi qua `terminal send` nguyên vẹn.
- **Worker có test trình duyệt: spec chèn sẵn câu tắt tiếng.** Video tự phát làm phiền
  user đang làm việc khác:

      Sau mỗi lần goto/reload, chạy `orca eval --expression "$(cat ~/.claude/scripts/orca-mute.js)"` trước mọi thao tác khác; không bấm play video; không bao giờ đụng âm lượng của máy.
- **Sau `worker_done`, nghiệm thu như một giám sát khó tính, rồi mới merge hay dựng ask tầng B.**
  User chỉ nhận bản đã qua nghiệm thu, không bao giờ nhận bản worker vừa trả.
  Mặc định chia hai vai (user chốt):
  - **Checker độc lập, mới tinh, chạy các bước kiểm cơ học dưới đây.** Coordinator viết
    spec nên mù cùng chỗ với spec, đã đọc báo cáo nên dễ duyệt cho qua, và output đối
    chiếu làm đầy context của nó. Chọn checker theo việc: sản phẩm nằm ở cwd khác
    coordinator (repo con, project ngoài umbrella) → worker Orca mới trong repo đó, kể cả
    chỉ đọc diff/PBIR/theme (subagent không nạp `CLAUDE.md` và hook của repo đó); cùng
    cwd và chỉ đọc file → subagent nếu worker là Claude (truyền `model`/`effort` bằng của
    worker), không thì worker Orca cùng agent · model · effort; task nhỏ (sửa chữ, đổi một
    filter) → coordinator tự kiểm. Không bao giờ là chính worker làm ra sản phẩm. Checker
    cùng agent · model · effort với worker như reviewer bên dưới (user chốt).
    Gửi checker mục Nghiệm thu, không gửi báo cáo của worker; đòi mỗi mục Nghiệm thu một
    kết luận kèm bằng chứng (ảnh chụp, query kèm output, số đối chiếu); không nhận "ok"
    hay một chữ PASS chung.
    Track coordinator tự làm (`ntv-implement` § Who works) mà có logic mới (hàm, query, nhánh điều kiện)
    vẫn qua checker độc lập như trên. Chỉ đổi giá trị hay tham số có sẵn, hoặc gỡ thứ vừa thêm, thì
    `Đã kiểm` cùng tầng của coordinator là nghiệm thu.
  - **Coordinator phán xét cuối:** đọc bằng chứng, đối chiếu với ý của user, mà
    checker chỉ biết qua mục Nghiệm thu. Một mục trượt trên đường nhạy cảm (tiền, gửi
    thư, dữ liệu người khác đọc) chặn cả khối, dù bao nhiêu mục khác đã qua.

  Các bước kiểm, ai chạy cũng vậy: bắt đầu từ sản phẩm, không từ báo cáo của worker
  (báo cáo chỉ chứa lỗi worker thấy được; coordinator đọc nó sau cùng). Mặc định còn
  ít nhất một lỗi chưa ai thấy và đi tìm nó. Đọc diff, chạy lại test, rồi đối chiếu
  với chuẩn trong mục Nghiệm thu:

  - Bước kiểm chính chạy cả trên bản base để chắc nó đỏ được; một bước kiểm không bao
    giờ đỏ thì không chứng minh gì.
  - UI: tự dựng server, chụp desktop và mobile đặt cạnh màn mẫu, grep màu hard-code
    ngoài token, đọc console.
  - Backend/data: so số dòng và tổng với nguồn theo từng nhóm khoá (ngày, shop, nguồn),
    không chỉ so tổng, lần 3 dòng từ nguồn tới đích, soát
    phân bố và null, kiểm quyền đọc của consumer; DDL/SQL thì dựng `probe_*`, chạy
    thật, đối chiếu, `DROP` trong cùng lượt.
  - BI (Power BI): trên macOS không xem được bản render — phải qua PR → merge →
    Fabric workspace update → refresh dataset mới nhìn được. Nên kiểm tính hợp lí trên
    file định nghĩa PBIR. Số: lấy 2–3 con số report sẽ hiện, tự tính lại từ nguồn
    bằng query riêng (không dùng query của worker), đối chiếu với một mốc đã biết như
    báo cáo kỳ trước của hệ cũ. Bố cục: đọc `position` trong `visual.json` của
    mọi visual trên trang — các visual cùng hàng/cột có `x`/`y` khớp nhau, không cái
    nào lệch trái phải; khoảng cách giữa các visual đều; không tràn khỏi
    `width`/`height` của `page.json`; chart và table đủ cao cho nội dung (table: tiêu
    đề + số dòng cần thấy + dòng Total). Màu: mã hex mà diff thêm vào phải có trong
    theme `StaticResources/RegisteredResources/*.json` hoặc đã dùng ở visual khác của
    report; màu lạ ngoài cả hai là lệch preset. Đừng đòi mọi hex nằm trong theme: report
    đang chạy có thể đã dùng màu ngoài theme (nền dòng, màu trạng thái). Table thấp quá
    thì dòng Total che dòng cuối, phải cuộn mới thấy.
    Nhìn bằng mắt sau refresh là việc của user: ghi vào ask tầng B dưới "CHƯA kiểm".

  Mục "CHƯA kiểm" của worker: kiểm hộ được thì chép từng việc vào việc của người kiểm,
  không thì ghi vào ask tầng B.
- **Đúng logic mà lệch chuẩn là chưa xong.** Trả về worker cũ (Rule 8b) kèm ảnh chụp
  hoặc query cho thấy chỗ lệch, và path của chuẩn; sửa xong thì nghiệm thu lại. Không
  duyệt "tạm" rồi để sau.
- **Task chạm UI, BI hoặc việc nhạy cảm (tiền, gửi thư, dữ liệu người khác đọc): thêm một
  reviewer chỉ đọc** sau `worker_done`, ngoài người chạy nghiệm thu, cùng agent · model ·
  effort với worker. Reviewer nhận ảnh chụp (BI: file PBIR), màn mẫu và diff; nhiệm vụ là
  tìm lỗi, không phải duyệt. Task khác chỉ có reviewer của vòng worker (bullet dưới).
- **Diff logic từ 30 dòng trở lên thì spec có mục "Review trước `worker_done`"** (user chốt):
  thêm + xoá trong `git diff --numstat origin/<base>...HEAD -- . ':!*.md' ':!*test*'`, trừ lockfile
  và dòng chỉ là comment hay docstring; worker tự đếm khi mở PR/MR. Ngoại lệ: task đổi cách tính
  tiền, nội dung thư, hay cách tính dữ liệu người khác đọc thì luôn có reviewer dù diff nhỏ (đổi
  phạm vi đọc, cửa sổ hay lịch chạy thì không tính), coordinator ghi rõ vào spec lúc giao. Dưới ngưỡng và
  không thuộc ngoại lệ thì không cần reviewer: coordinator nghiệm thu bằng bằng chứng cùng
  tầng. Coordinator chỉ nhận PR/MR hoàn chỉnh. Một reviewer chỉ đọc xét diff theo Scope và mục Nghiệm thu, **cùng
  agent · model · effort với worker** (worker `antigravity gemini-3.8-flash high` → reviewer
  y vậy); chỉ dùng model khác khi user nêu đích danh, không bao giờ tự chuyển sang model mạnh
  hơn hay sang Claude. Worker sửa tới PASS rồi mới `worker_done`, kèm kết luận của reviewer;
  chưa có PASS → trả lại. PASS chỉ là đầu vào, không phải cổng merge: coordinator vẫn tự đọc diff, chạy cổng và chạy thật trước khi duyệt. Cách spawn ghi một lần trong manifest:
  worker tự spawn reviewer mới bằng `orchestration worker-start` (worker Claude: subagent
  native cũng được; self-review hay `spawn_agent` của chính worker không tính); agent bị
  `consumer_fenced` khi gọi `worker-start` → worker push +
  mở PR/MR rồi `ask` "review", coordinator spawn reviewer là worker Orca cùng agent · model ·
  effort trên worktree đó và chuyển nguyên văn findings cho worker qua `orchestration send
  --to dispatch:<id>` (worker chat không nhận `terminal send`). Reviewer thuộc track của worker nó review, không phải worker lẻ. Spec reviewer ghi sẵn hai câu:
  dán nguyên danh sách findings vào body tin của nó (không chỉ trỏ tới file); lỗi đã có trên
  `origin/<base>` không tính FAIL.
- **Tiêu chí dừng, chốt trước vòng review đầu.** Reviewer được giao tìm lỗi thì luôn tìm ra thêm. Spec review có mục
  `## Tiêu chí dừng`: chỉ finding làm sai output thật khi dùng bình thường (chạy thật, replay) mới
  chặn merge; finding về công cụ hay ca mà luồng đang dùng không chạm thì ghi "giới hạn đã biết"
  vào mô tả PR/MR, không sửa: đây là ngoại lệ user đặt cho câu "fix what the review finds" của
  `CLAUDE.md`. Sau khi thiết kế ổn định, tối đa 2 vòng review; muốn vòng 3 thì hỏi user như một câu về
  chi phí (thời gian và lượt worker của vòng thêm, cùng những gì nó có thể bắt). Từ vòng 2,
  prompt reviewer hỏi "đã sẵn sàng merge chưa, chỉ liệt kê lỗi chặn merge" và nêu số vòng đã qua
  (`knowledge/codex.md`).
- **Finding coordinator tự gửi worker** dẫn cả nơi sinh giá trị lẫn nơi đọc (`file:dòng`
  mỗi đầu), hoặc kèm một ca chạy thật; chỉ dẫn nơi đọc là chưa kiểm: nơi sinh có thể đã
  trả đúng, worker mất một vòng sửa lỗi không có.

## Chế độ không người

Bot 24/7 là coordinator không có user. Phase 2 của nó = `AGENTS.md § Phạm vi tự chủ`
của repo đích ∩ scope trong `CLAUDE.md` của bot. Không bao giờ mở tầng B hay C; gặp thứ
ngoài policy → park + escalate qua kênh của bot, làm item tiếp theo. Mỗi item bot tự
làm; chỉ sinh worker khi ≥2 item chạy song song (Rule 1). Hợp đồng phía repo đích nằm trong
`AGENTS.md`/SOP của repo đó.

## Năm thứ không có ngoại lệ

- **Mọi worker cùng repo phải có worktree riêng.** (Rule 2) Kể cả worker "chỉ đọc" —
  read-only vẫn có thể tự `git checkout` ngoài scope brief. Coordinator từng mất
  branch `main` vì chuyện này.
- **File spec phải với tới được từ worktree của worker TRƯỚC khi spawn.** (Rule 12)
  Worktree mới là checkout sạch từ base branch, mà base mặc định là ref REMOTE:
  commit local chưa đủ. Commit + push, hoặc copy sang, hoặc nhét thẳng vào
  `--spec`.
- **Scout + chốt phương án + fix trong CÙNG một session worker.** (Rule 8a) Xả session rồi
  nạp lại để fix là trả tiền nạp harness hai lần cho cùng một việc.
- **Giữ worker sau `worker_done` chỉ khi có việc kế tiếp cụ thể cho nó, tới trong TTL cache.**
  (Rule 8b, Rule 20) Terminal idle tốn RAM, và quá TTL (Claude 1 giờ, codex GPT-6 30 phút) thì
  đánh thức nó đắt như nạp mới. Có việc như vậy → `worker-keep-open --dispatch <id>` (worker trong worktree mới thì đã mở sẵn).
  Không có → `worker-release`
  ngay (Orca đóng tab của worker), gỡ worktree (sao lưu báo cáo trước); việc tới muộn thì spawn mới
  cùng worktree, đọc báo cáo bàn giao.
- **Cấp port riêng cho từng worktree NGAY TRONG SPEC, kèm cờ strict.** (Rule 19)
  Nhiều worktree cùng repo chạy cùng script dev nên trùng port mặc định, mà vite
  thiếu `--strictPort` thì **tự nhảy port và không báo**: worker mở port nó tưởng
  là của mình, chụp màn, rồi mô tả app của worktree khác. Trang render bình
  thường, không lỗi nào để nghi — verify sai nguy hơn không verify. Trước mỗi
  wave xem ai giữ gì bằng `lsof -nP -iTCP -sTCP:LISTEN`, rồi ghi
  `npm run dev:ui -- --port <n> --strictPort` vào spec. Nhớ `wrangler pages dev`
  (8788) là không gian đụng độ **tách biệt** với vite (5173) — hai worker "khác
  script" vẫn đụng nhau. Cùng chỗ này, spec phải bảo worker `cp <repo>/.env .`:
  worktree mới không có `.env` (gitignored), app crash trước khi mount và worker
  chỉ phát hiện sau khi đã làm xong việc.

## Trạng thái Orca báo là claim, không phải fact

`escalation`, `succeeded`, `ok: true`, `failed timeout` đều là claim ở tầng
protocol. Fact lấy từ thứ không đi qua Orca: counter trong `orca terminal read`,
`ps`, `git -C <worktree> log`, `git -C <worktree> status --short`,
`gh pr list --head <branch>`.

Bảng tra theo triệu chứng: `SKILL.md`, đầu Nhóm D.

Cross-ref: `rules/orchestration-protocol.md` (delegation context, status
protocol, model escalation) · `rules/process-management.md` (dev server,
watcher, tiến trình mồ côi).

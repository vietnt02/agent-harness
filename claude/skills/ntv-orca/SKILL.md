---
name: ntv-orca
description: "Vai coordinator (PM/SA) khi giao việc cho worker Orca: ai làm gì, coordinator chịu trách nhiệm gì, giao việc, duyệt kế hoạch, giữ cổng merge và production. Không phải tham chiếu lệnh Orca — lệnh, cờ và cách gỡ lỗi tra bằng `orca <lệnh> --help` và `orca skills get orchestration`."
user-invocable: true
when_to_use: "Đọc trước khi soạn manifest, trước khi spawn worker Orca đầu tiên của phiên, khi user nói \"giao worker\", \"supervised agent/worker\", và khi một câu hỏi của user cần rà repo con. Chỉ dành cho agent điều phối, không dành cho worker."
category: utilities
keywords: [orca, orchestration, worker, coordinator, dispatch, review, gate]
---

# Orca — vai coordinator (PM/SA)

Coordinator là PM/SA của dự án, không phải người đi code. Nó giữ hai đầu: **ý của user** ở đầu vào
và **cổng** ở đầu ra (duyệt kế hoạch, merge, production). Phần giữa: đọc, tìm là việc của subagent
rà; thiết kế, làm là việc của worker. Coordinator tự làm nghĩa là tốn quota Claude của phiên điều phối và bỏ trống
vai giữ cổng.

- **Lệnh và cờ:** `orca <lệnh> --help`; quy trình giám sát, nhắn tin, gỡ lỗi:
  `orca skills get orchestration` (gặp cổng nó nêu thì `--reference references/<file>.md`). Guide
  đi kèm đúng bản Orca đang chạy và thắng mọi câu về lệnh trong file này.
- **Máy và cấu hình đang dùng** (RAM, cap worker, Settings của Orca, Setup Script, agy):
  `~/.claude/knowledge/orca.md`.
- **Từng dòng model:** `references/models/<dòng>.md`; agy: `references/antigravity.md`.

## 1. Phân vai

Chỉ coordinator nói chuyện với user; worker chỉ hỏi coordinator (`ask`).

| Chặng | Coordinator | Worker |
|---|---|---|
| 1. Nhận việc | Hiểu ý user, chốt phạm vi và tiêu chí xong (thứ user sẽ thấy). Ý chưa rõ thì hỏi user. | — |
| 2. Rà, giao | **Không tự rà:** đích chưa rõ thì giao subagent rà (dưới), bản đồ nó trả về đi vào plan và spec. Manifest là một mục của plan `ntv-autopilot`; plan duyệt xong mới viết spec (§ 2), spawn. | — |
| 3. Lập kế hoạch | — | Đọc đúng chỗ bản đồ hay đích spec nêu, query dữ liệu thật trên toàn bộ dữ liệu. Gửi kế hoạch qua `ask`: thiết kế (hàm, luồng, ca biên, test phải chứng minh gì), kèm output thô và `file:dòng`. Chưa sửa gì. |
| 4. Duyệt kế hoạch | Đối chiếu kế hoạch với ý user và với bằng chứng worker dán; nghi chỗ nào thì tự chạy **một** lệnh đọc đúng chỗ đó. Lựa chọn đổi thứ user hay người dùng thấy mà plan chưa ghi → park, hỏi gộp sau lượt (`ntv-autopilot` § Report). Duyệt hoặc trả lại kèm lý do. | Sửa kế hoạch, gửi lại. |
| 5. Làm | Trả lời `ask` nhanh — worker đang đứng chờ; không làm thay. | Code, test, commit, push nhánh, mở PR/MR. Lệnh ghi production chỉ dựng lệnh và chạy `--dry-run`, báo output. |
| 6. Review | Spawn reviewer khi cần (§ 4); quyết từng finding sửa hay bỏ. | Reviewer tìm lỗi, dán bằng chứng; worker sửa theo finding đã quyết. |
| 7. Cổng, chạy thật | Đọc toàn bộ diff tới đúng SHA sẽ merge, chạy check của repo trên SHA đó, merge. Tự chạy lệnh ghi production thật, đọc lại đích. Sau deploy đọc thứ đang chạy trên production. | — |
| 8. Báo cáo | Báo user đã kiểm gì, chưa kiểm gì, release worker. | `worker_done`: đã kiểm gì, chưa kiểm gì. |

**Câu hỏi của user về hệ thống** ("bảng này đã có bên PG chưa", "còn job nào chạy không"):
coordinator trả lời từ thứ đang có, hoặc chạy **một** lệnh xác nhận một đích đã biết (một file, một
trạng thái). Cần hơn một lệnh, hay chạm nhiều repo → giao ngay subagent rà `ntv-scout` chạy nền
(không cần manifest: câu hỏi đã mở khối cho nó, `CLAUDE.md` § Delegation): brief nêu câu hỏi, đích
đã biết, trần chi phí nếu có query tính tiền. Đây là cách `CLAUDE.md` § Verification ("run the reads
that answer it") áp ở vai coordinator: lần đọc vẫn chạy, nhưng trong context gọn của subagent, không
trong context lớn của coordinator.

**Coordinator tự làm, không giao, chỉ khi:** sửa harness (`~/.claude` và repo nguồn cài ra nó, `.claude/` của một repo) trong phiên user mở cho
harness/kaizen hoặc khối gọi tên nó (gặp lỗi harness lúc làm việc khác → ghi kaizen, `ntv-kaizen`); đổi một giá trị có sẵn, không
logic mới; việc cần công cụ chỉ phiên này có (MCP, login); user chỉ đích danh Claude; cổng merge,
theo dõi CI, ghi production (`ntv-implement` § Who works).

**Worker lặp lại cùng một lỗi:** không vá từng ca. Coordinator yêu cầu worker phân tích nguyên nhân
gốc (cơ chế sinh ra cả lớp lỗi) và gửi kế hoạch mới; coordinator duyệt. Hết vòng mà vẫn sai → đổi
worker; model theo **Chọn model** (§ 2). Lỗi do skill chỉ sai bước hoặc luật mơ hồ thì ghi kaizen (`ntv-kaizen`); spec thiếu thì sửa spec.

**Mọi dòng model đều lập kế hoạch.** `gemini-flash`/`gpt-luna` không tự phản biện spec, nên ở
chặng 4 coordinator đối chiếu từng con số trong kế hoạch với output thô worker dán.

## 2. Giao việc

**Orca hay subagent native:** việc chỉ đọc (rà, dò dữ liệu, tìm nguyên nhân gốc), ở repo nào cũng
vậy → subagent `ntv-scout` chạy nền. Việc còn lại kết thúc bằng commit/PR, chạm repo khác, phải sống
qua phiên, hay user nói "supervised" → worker Orca. Orca không chạy (`orca status --json`) mà việc cần Orca → báo user, không tự làm thay.

**Manifest — một mục của plan `ntv-autopilot`** (`CLAUDE.md` § Mutation gate): plan có giao
worker thì chốt model, worktree ngay trong plan; duyệt plan là duyệt manifest, không hỏi lại.
Không có plan đã duyệt thì không spawn worker; manifest trích plan, không thay plan. Mỗi worker
một dòng:

    Manifest khối <X> — parallel <n> (cap <N>), <agent> <slug> <effort>.
      Kế hoạch: <k> phase · <n> worker · w1-<việc>: phase 1, 2 · w2-<việc>: phase 3
      <repo> · <worktree> · <paths> · được: rà, lập kế hoạch, edit, commit, push nhánh, mở PR
      KHÔNG (worker): merge, deploy, publish, ghi prod (Lark, n8n, DB), chạy job thật, gửi tin: chỉ dry-run

- Mỗi phase kèm bằng chứng chưa làm, đọc từ nhánh chính và PR/MR đang mở của repo đích, không từ
  cột trạng thái của plan. Worker không sửa bảng trạng thái trong file plan dùng chung (các nhánh
  conflict khi merge); coordinator cập nhật sau merge.
- Worker tên `w<N>-<việc>`, N theo thứ tự dispatch, không cấp lại; dùng cho `--task-title`
  và mọi báo cáo; `--name`, `--display-name` chỉ thêm khi `--worktree new-child|new-top-level`.
  Reviewer là một dòng `w<N>-review-w<M>`, tính vào cap.
- Đổi phase, worker hay model sau khi plan duyệt → plan về `draft`, hỏi lại, không báo sau;
  ngoại lệ: đổi sang carbon theo **Chọn model** (dưới) chạy luôn, báo trong report.
- Manifest chỉ phủ tầng A của worker. Tầng C plan ghi tên thì coordinator chạy theo plan; tầng C
  ngoài plan thì park (`CLAUDE.md` § Irreversible actions). Bot không người không bao giờ mở tầng C.

**Spec** gồm: câu của user; những gì coordinator đang có (link, lỗi, dữ liệu đã thấy, bản đồ của
subagent rà: `file:dòng`, bảng, cột); giả thuyết và
hướng đề xuất; khối `Scope:` (chép đúng dòng manifest của worker đó; ngoài scope thì `ask`); mục **Nghiệm thu** (kết quả user thấy, chuẩn đối
chiếu trỏ đúng path, bằng chứng coordinator sẽ thu); và yêu cầu:

- gửi kế hoạch qua `ask` trước khi sửa, kèm output thô của query chạy trên toàn bộ dữ liệu;
- kiểm hộp thư giữa lượt: chạy `orca orchestration check --peek` trước mỗi commit, trước một lệnh
  dài, và sau khoảng mỗi 10 lệnh; có tin mới của coordinator thì làm theo tin đó trước, tin đã làm
  theo thì bỏ qua khi thấy lại (`--peek` không đánh dấu đã đọc; worker Chat có nhận tin `send` giữa
  lượt hay không tuỳ bản Orca, xem `~/.claude/knowledge/orca.md`);
- chép mọi cổng "trước khi mark ready" mà `AGENTS.md`/`CLAUDE.md` của repo đòi;
- mọi path, con số, phản hồi giả lập của API ngoài trỏ được tới nguồn đã đọc, không có thì ghi
  "giả định" tại chỗ; fixture không chứa đường dẫn máy, stack trace hay thời điểm chạy;
- task viết/sửa test, đổi logic, hay chạm hệ thống ngoài, dữ liệu thật, lịch, quyền: trích `ntv-test`
  § 1–3; worker chạy mutation và kiểm thực tế trước review, PR ghi kết quả; coordinator soát ở bước 7.
  Test chặn mặc định side effect ra ngoài (thông báo OS, gửi tin, ghi API); lượt kiểm thật chạy
  trên bản sao state, không bao giờ trên state bản live đọc (`ntv-test` § 2);
- báo cáo nói đã kiểm gì, bằng cách nào, và chưa kiểm gì, vì sao;
- các câu trong mục "Phải nói rõ trong spec" của file model đang dùng;
- worker mở trình duyệt: câu tắt tiếng sau mỗi lần tải trang (`~/.claude/knowledge/browser-debug.md`);
- spec viết tiếng Việt có dấu (bỏ dấu thì "dung" là dùng/đừng/đúng/dựng).

Worktree mới chỉ thấy thứ đã **push** lên ref base (thường `origin/main`): file coordinator soạn dở
thì push trước, copy vào worktree, hoặc đưa thẳng vào spec (`--spec-file`). Không có lỗi nào báo
khi worker dựng trên base cũ.

**Worktree:** mỗi worker một worktree riêng. Repo có quy ước worktree trong
`AGENTS.md`/`docs/` thì theo quy ước đó (thường `git worktree add` rồi `--worktree path:<abs>`);
không có thì `--worktree new-child`. Worktree `path:` không chạy Setup Script: chạy tay trước khi
spawn (script: `knowledge/orca.md`). Worker cần harness của repo con (MCP, hook, skill) phải chạy
với cwd ở repo đó; coordinator ở umbrella không gọi được MCP của repo con. Nhiều worktree cùng repo
chạy dev server thì spec cấp port riêng kèm `--strictPort`.

**Song song và cap:** mặc định parallel tới cap (user chốt): mỗi track — nhóm việc chung file nguồn —
một worker, một nhánh, dispatch cùng lúc. Serial chỉ khi user nói hoặc áp lực bộ nhớ ≥ 2
(`sysctl -n kern.memorystatus_vm_pressure_level`). Cap là ràng buộc RAM của máy
(`knowledge/orca.md`); "max N" của user là N worker sống cùng lúc xuyên phiên. Còn slot và còn việc
đủ điều kiện thì giao ngay, không chờ cả wave. Dòng `# Track:` liệt kê việc và file giúp hook
`dispatch-split-guard` nhắc khi một worker ôm các việc không chung file. Các track phụ thuộc nhau mà repo có cổng chạy toàn bộ
test: worker commit local, coordinator gộp vào nhánh tích hợp, mở PR từ đó. Không `--no-verify`. Các nhánh phải
lên production cùng nhau, hoặc cùng kích hoạt một pipeline deploy/publish tính tiền, cũng gộp như
vậy thành một PR/MR để pipeline chạy một lần: gộp nhánh, không gộp worker — các worker vẫn chạy song song.

**Chọn model** (user chốt; mỗi dòng một file trong `references/models/`):

- Không dùng model Claude cho worker, reviewer hay checker (quota Claude để cho coordinator); ngoại
  lệ: review thay đổi của chính harness là subagent Claude (`ntv-implement` § Verify), và chặng rà
  là subagent `ntv-scout` (Sonnet, § 1).
- Worker luôn là Gemini qua Antigravity; codex (GPT) hay Claude chỉ khi user chỉ định. Builder và
  research mọi mức độ → `agy gemini-4-hydrogen high`; `agy gemini-4-carbon high` chỉ khi user chỉ
  định hoặc hydrogen trượt review hai vòng trên cùng một thiết kế đã duyệt; `gemini-flash` chỉ khi user chỉ
  định. Mọi model Gemini trên `agy` chung một quota, nên hết quota thì không đổi
  sang model Gemini khác. Reviewer mặc định `agy gemini-4-argon high`.
- Không giao task dài cho model context ngắn (`gemini-flash`, `gpt-luna`): chia task nhỏ, mỗi task
  một worker mới, commit + push mỗi nhóm việc ≤ 30 phút.
- Truyền `--agent`, `--model` (slug thật), `--effort` đúng frontmatter. Slug: agy `agy models`;
  codex `~/.codex/models_cache.json`. Lỗi trích lại đúng chuỗi vừa gõ (`'luna'`) nghĩa là sai slug,
  không phải model thiếu năng lực. Sau spawn, so `launch.effective` với `launch.requested`.

## 3. Trong lúc chạy

- **Giao xong thì kết thúc lượt; Orca đánh thức** khi worker `worker_done`, hỏi, hay dừng không báo
  (`escalation`). Không chạy vòng poll hay script nào đọc `check`: process khác đọc là lấy mất tin.
  Mỗi lần được đánh thức: chạy đúng lệnh `check` của lời nhắc, xử lý mọi tin. Riêng việc theo dõi treo:
  `watch.sh` với `~/.claude/scripts/worker-stall.cjs` (receipt của `worker-start` in sẵn lệnh; nó không
  đọc `check`), vì worker lặp lỗi API hay đứng im thì Orca không đánh thức.
- **Trả lời `ask` ngay.** Worker hỏi vì thiếu quyền hay credential → trả lời bằng đường đã ghi trong
  `AGENTS.md`/`docs/` của repo, không chạy hộ. Ngoại lệ: lệnh ghi production là việc của coordinator.
- **Session worker là tài sản** (~30–60k token nạp). Việc kế tiếp cụ thể cần đúng context của worker
  đó và tới trong TTL cache (codex 30 phút, Claude 1 giờ) → giao bằng `send --to dispatch:<id>`
  (thành Task mới). Việc định gửi bằng `send` phải xét lại **Chọn model** (§ 2) như một lần giao
  mới: khác loại task, hoặc làm task vượt mức § 2 cho model context ngắn → worker mới (ngoài
  manifest đã duyệt thì hỏi lại, § 2). Tin `send` tới
  worker Chat đang trong lượt: ngắt lượt đó hay nằm Queued tới lần `check --peek` kế tiếp mà spec
  đòi (§ 2) là tuỳ bản Orca (`~/.claude/knowledge/orca.md`); khung chat của worker cho thấy lượt
  mới, `worker-read --source transcript` thì không. Tin gấp mà worker không làm theo trong vài phút
  (đang chạy một lệnh dài, hoặc spec giao trước khi có câu kiểm hộp thư) → coordinator tự
  `worker-stop`, rồi `worker-start --spec-file` mới gồm spec cũ, nội dung tin và câu kiểm hộp thư,
  cùng `--worktree path:` cũ; không nhờ user bấm Steer, không chờ user. Không có việc kế tiếp →
  release ngay (`worker-release`, chỉ worker đã `worker_done`, chưa thì `worker-stop`; worker trong worktree mới không tự đóng), gỡ worktree sau khi lưu
  báo cáo. Đừng release rồi vài phút sau spawn lại; cũng đừng giữ "phòng khi cần".
- **Worker im lâu:** đọc `worker-read --source transcript` hai lần cách nhau vài phút trước khi kết
  luận. Im lặng, timeout hay `unverifiable` không bao giờ đủ để tự dừng, bỏ hay chạy lại worker
  (guide). Worker còn sống thì nó vẫn là người sửa duy nhất của worktree.

## 4. Cổng

**Review.** Diff logic từ 30 dòng (trừ test, doc, lockfile), hoặc task chạm tiền, thư gửi khách, dữ
liệu người khác đọc, UI hay BI → có reviewer (`agy gemini-4-argon high`, worker riêng) trước khi
merge. Reviewer nhận diff, Scope, mục Nghiệm thu và hai câu hỏi cố định: lượt chạy xấu nhất (số
item tối đa × thời gian đo trên lần chạy thật) có lọt trần thời gian của runtime không; và tiến trình
nào khác (nút bấm, lịch, webhook) ghi hay gửi cho cùng bản ghi trong cùng khoảng thời gian. Spec reviewer đòi dán nguyên findings kèm output
thô và `file:dòng`; finding coordinator tự gửi worker cũng dẫn `file:dòng` cả nơi sinh lẫn nơi đọc
giá trị, hoặc kèm một ca chạy thật. Phạm vi reviewer cố định (user chốt): diff, hai câu hỏi trên và
bằng chứng; mutation chỉ kiểm lại một module worker đã báo, đo một lượt chạy thật trên bản sao state (`ntv-test` § 2); vòng 2 chỉ kiểm
các finding đã sửa. Coordinator quyết từng finding và đối chiếu ít nhất một bằng chứng với nguồn
thật; PASS của reviewer chỉ là đầu vào. **Tiêu chí dừng:** chỉ finding làm sai output thật khi dùng
bình thường mới chặn merge; còn lại ghi "giới hạn đã biết" vào PR. Sau khi thiết kế ổn định tối đa
2 vòng review; hydrogen trượt cả hai thì đổi sang carbon (§ 2) thay cho vòng 3; muốn vòng 3 với
cùng worker thì hỏi user như một câu về chi phí.

**Nghiệm thu** — user chỉ nhận bản đã qua nghiệm thu:

- Bắt đầu từ sản phẩm, không từ báo cáo của worker; mặc định còn ít nhất một lỗi chưa ai thấy.
- Bước kiểm chính phải đỏ được trên bản base.
- Checker độc lập (worker mới, không phải worker làm ra sản phẩm) chạy các bước kiểm cơ học khi
  task có logic mới; nhận mục Nghiệm thu, không nhận báo cáo của worker; mỗi mục một kết luận kèm
  bằng chứng. Task nhỏ (sửa chữ, đổi một tham số) → coordinator tự kiểm.
- UI: chụp desktop và mobile cạnh màn mẫu. Data: so số dòng và tổng theo từng nhóm khoá với nguồn.
  BI: tự tính lại 2–3 con số từ nguồn bằng query riêng; bố cục đọc từ file định nghĩa.
- Đúng logic mà lệch chuẩn là chưa xong: trả về worker kèm bằng chứng chỗ lệch.
- Một mục trượt trên đường nhạy cảm (tiền, gửi thư, dữ liệu người khác đọc) chặn cả khối.

**Merge và production** (`ntv-implement` § Ship): coordinator đọc toàn bộ diff từ lần đọc trước tới
đúng SHA sẽ merge và chạy check của repo trên SHA đó. "Đã deploy/đã ghi" chỉ nhận khi đọc lại đích
(n8n: workflow trên instance; DAG: trạng thái task). Lệnh ghi production không giao worker (hook
`dispatch-split-guard` chặn spec có lệnh ghi Lark/n8n thật).

## 5. Chế độ không người

Bot chạy liên tục là coordinator không có user. Việc nó được làm là `AGENTS.md § Phạm vi tự chủ` của
repo đích giao với scope trong `CLAUDE.md` của bot. Không bao giờ mở tầng C; gặp thứ ngoài
policy → park, báo qua kênh của bot, làm item tiếp theo. Chỉ sinh worker khi có từ 2 item chạy song
song.

## 6. Khi có sự cố

Trạng thái Orca báo là claim của Orca; sự thật lấy từ thứ không đi qua Orca (`git -C <worktree> log`,
`git status --short`, PR, transcript của worker). Còn lại: guide `references/recovery-and-cleanup.md`.

| Triệu chứng | Làm gì |
|---|---|
| `worker-start` lỗi | Không chạy lại y nguyên; đọc `failedStage`, `next` của receipt (hook `worker-start-receipt` in sẵn dòng liên quan). Ba lần lỗi trong một chuỗi `--retry-of` thì Task bị khoá, chỉ mở lại khi user yêu cầu. |
| Sau khi Orca restart | `worker-list --run <run> --json` và `ps` trước; thử giao tiếp worker cũ trước khi spawn mới. |
| Worker Claude thoát về shell ở repo lạ | Repo chưa trust: nhờ user mở repo bằng Claude Code một lần. |
| Worker agy kẹt khởi động hay lệch tài khoản | `references/antigravity.md`. |
| Thao tác setup một lần agent không tự vượt được (login, trust) | Báo user ngay, một dòng. |

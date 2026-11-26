---
name: ntv-orca
description: "Vai coordinator (PM/SA) khi chia việc giữa Claude, subagent và worker Orca: ai làm gì, coordinator giữ gì, giao việc, review độc lập, cổng merge và production. Không phải tham chiếu lệnh Orca — lệnh, cờ và hành vi theo bản ở `references/orca.md`, `orca <lệnh> --help` và `orca skills get orchestration`."
user-invocable: true
when_to_use: "Đọc trước khi soạn manifest, trước khi spawn worker Orca đầu tiên của phiên, khi user nói \"giao worker\", \"supervised agent/worker\", khi user nhờ review một PR/MR của bất kỳ ai, và khi một câu hỏi của user cần rà repo con. Chỉ dành cho agent điều phối, không dành cho worker."
category: utilities
keywords: [orca, orchestration, worker, coordinator, dispatch, review, gate]
---

# Orca — vai coordinator (PM/SA)

Coordinator giữ ý của user, thiết kế, tiêu chí nghiệm thu và các cổng (merge, production). Nó tự làm
việc một mạch còn cần phán đoán về ý user; worker làm các mạch song song mà thiết kế đã quyết hết và
việc cơ học; subagent đọc rà; review do agent độc lập làm (`CLAUDE.md` § Delegation). Tách việc để rút
thời gian (mạch song song) hay nâng chất lượng (review độc lập), không để bớt quota.

- **Protocol:** file này. Đọc kèm `references/lessons.md` trước manifest hay spec đầu tiên của phiên:
  luật sinh từ chỗ đã hỏng, mỗi luật kèm cơ chế của nó.
- **Lệnh, cờ, hành vi theo bản Orca:** `references/orca.md`; lệnh và cờ đầy đủ: `orca <lệnh> --help`;
  quy trình giám sát, nhắn tin, gỡ lỗi: `orca skills get orchestration` (gặp cổng nó nêu thì
  `--reference references/<file>.md`). Guide đi kèm đúng bản Orca đang chạy và thắng mọi câu về lệnh ở
  đây.
- **Máy và cấu hình đang dùng** (RAM, cap worker, Settings của Orca, Setup Script, agy):
  `~/.claude/knowledge/orca.md`.
- **Từng dòng model:** `references/models/<dòng>.md`; agy: `references/antigravity.md`.

## 1. Phân vai

Chỉ coordinator nói chuyện với user; worker chỉ hỏi coordinator (`ask`).

| Loại việc | Ai làm | Ai review |
|---|---|---|
| Một mạch, còn cần phán đoán về ý user | Coordinator (`ntv-implement`) | Agent độc lập (§ 4) |
| Nhiều mạch độc lập | Coordinator làm mạch còn cần phán đoán; worker làm song song các mạch thiết kế đã quyết hết | Agent độc lập, không phải tác giả |
| Việc cơ học (sweep, nhiều file giống nhau) | Worker | Agent độc lập |
| Đọc, rà nhiều nơi | Subagent `ntv-scout` chạy nền | — |

Luôn là coordinator: sửa harness (`~/.claude` và repo nguồn cài ra nó, `.claude/` hay rule agent của
một repo), chỉ trong phiên user mở cho harness/kaizen hoặc khối gọi tên nó (gặp lỗi harness lúc làm
việc khác → ghi kaizen, `ntv-kaizen`: không sửa, không PR, không hỏi mở); việc cần công cụ chỉ phiên này
có (MCP, login); việc user chỉ đích danh Claude; đổi một giá trị có sẵn, không logic mới; ghi không có cổng phía sau (Lark, n8n, DB, chạy job
thật, gửi tin, publish tay như Power BI): worker chỉ rà, dựng lệnh và chạy `--dry-run`, coordinator đọc
output đó, chạy thật, đọc lại đích (hook `dispatch-split-guard` chặn spec hay tin giao worker một lệnh
ghi Lark/n8n; nó không thấy SQL, curl hay lệnh kích job).

| Chặng | Coordinator | Worker |
|---|---|---|
| 1. Nhận việc | Hiểu ý user, chốt phạm vi và tiêu chí nghiệm thu (thứ user sẽ thấy) trong plan `ntv-autopilot` trước khi làm. Ý chưa rõ thì hỏi user. | — |
| 2. Rà, thiết kế | Đích chưa rõ thì giao subagent rà (dưới); bản đồ nó trả về đi vào thiết kế. Coordinator thiết kế: hướng làm, hàm, luồng, ca biên, test phải chứng minh gì. Việc khó đảo ngược (schema, migration, contract công khai, dữ liệu người khác đọc): song song, một agent context mới (model theo § 4) nhận câu của user, dữ kiện và ràng buộc, không nhận thiết kế của coordinator, rồi đề xuất; coordinator so hai bản, ghi chỗ nhận, chỗ bỏ vào plan. | — |
| 3. Giao | Manifest là một mục của plan `ntv-autopilot`; plan duyệt xong mới viết spec (§ 2), spawn. | — |
| 4. Đối chiếu | Trả lời mâu thuẫn worker báo: sửa đúng phần thiết kế đó hay giữ, kèm lý do; nghi chỗ nào thì tự chạy **một** lệnh đọc đúng chỗ đó. Worker `gpt-luna` không tự phản biện spec: đối chiếu từng con số nó báo với output thô. Lựa chọn đổi thứ user hay người dùng thấy mà plan chưa ghi → park, hỏi gộp sau lượt (`ntv-autopilot` § Report). | Đọc đúng chỗ thiết kế nêu, query dữ liệu thật trên toàn bộ dữ liệu khi thiết kế dựa vào dữ liệu; chỗ code hay dữ liệu mâu thuẫn thiết kế thì gửi qua `ask`, kèm output thô và `file:dòng`, rồi chờ trả lời; không mâu thuẫn thì làm luôn, ghi điều đó vào báo cáo. Không lập kế hoạch lại. |
| 5. Làm | Trả lời `ask` nhanh — worker đang đứng chờ. | Code, test, commit, push nhánh, mở PR/MR. Lệnh ghi production chỉ dựng lệnh và chạy `--dry-run`, báo output. |
| 6. Review | Giao review độc lập (§ 4); quyết từng finding sửa hay bỏ. | Reviewer tìm lỗi, dán bằng chứng; người làm sửa theo finding đã quyết. |
| 7. Cổng, chạy thật | Theo dõi CI. Đọc toàn bộ diff tới đúng SHA sẽ merge, chạy check của repo trên SHA đó, merge. Tự chạy lệnh ghi production thật, đọc lại đích. Sau deploy đọc thứ đang chạy trên production. | — |
| 8. Báo cáo | Báo user đã kiểm gì, chưa kiểm gì, một lần cho cả khối (§ 3); worker đã release thì gỡ worktree (`references/orca.md`). | `worker_done`: đã kiểm gì, chưa kiểm gì. |

**Câu hỏi của user về hệ thống** ("bảng này đã có bên PG chưa", "còn job nào chạy không"):
coordinator trả lời từ thứ đang có, hoặc chạy **một** lệnh xác nhận một đích đã biết (một file, một
trạng thái). Cần hơn một lệnh, hay chạm nhiều repo → giao ngay subagent rà `ntv-scout` chạy nền
(không cần manifest: câu hỏi đã mở khối cho nó, `CLAUDE.md` § Delegation): brief nêu câu hỏi, đích
đã biết, trần chi phí nếu có query tính tiền. Đây là cách `CLAUDE.md` § Verification ("run the reads
that answer it") áp ở vai coordinator: lần đọc vẫn chạy, nhưng trong context gọn của subagent, không
trong context lớn của coordinator.

**Worker lặp lại cùng một lỗi:** không vá từng ca. Coordinator yêu cầu worker phân tích nguyên nhân
gốc (cơ chế sinh ra cả lớp lỗi) và xem lại phần thiết kế liên quan; hết vòng mà vẫn sai → đổi worker;
model theo **Chọn model** (§ 2). Lỗi do skill chỉ sai bước hoặc luật mơ hồ thì ghi kaizen
(`ntv-kaizen`); spec thiếu thì sửa spec.

## 2. Giao việc

**Orca hay subagent native:** việc chỉ đọc (rà, dò dữ liệu, tìm nguyên nhân gốc), ở repo nào cũng
vậy → subagent `ntv-scout` chạy nền. Việc còn lại kết thúc bằng commit/PR, chạm repo khác, phải sống
qua phiên, hay user nói "supervised" → worker Orca. Orca không chạy (`orca status --json`) mà việc cần Orca → báo user, không tự làm thay.

**Manifest — một mục của plan `ntv-autopilot`** (`CLAUDE.md` § Mutation gate): plan có giao
worker thì chốt model, worktree ngay trong plan; duyệt plan là duyệt manifest, không hỏi lại.
Không có plan đã duyệt thì không spawn worker; manifest trích plan, không thay plan. Ngoại lệ: reviewer chỉ đọc do câu của user mở (review PR/MR của bất kỳ ai) giao ngay, không plan, không manifest; đăng gì lên PR/MR vẫn hỏi riêng. Agent thiết kế độc lập của chặng 2 cũng giao ngay, không manifest: nó chỉ đọc và đề xuất. Mỗi worker
một dòng:

    Manifest khối <X> — parallel <n> (cap <N>).
      Kế hoạch: <k> phase · <n> worker · w1-<việc> (<agent> <slug> <effort> · <dấu hiệu>): phase 1, 2 · w2-<việc> (…): phase 3
      <repo> · <worktree> · <paths> · được: rà, đối chiếu thiết kế, edit, commit, push nhánh, mở PR
      KHÔNG (worker): merge, deploy, publish, ghi prod (Lark, n8n, DB), chạy job thật, gửi tin: chỉ dry-run

- Mỗi phase kèm bằng chứng chưa làm, đọc từ nhánh chính và PR/MR đang mở của repo đích, không từ
  cột trạng thái của plan. Worker không sửa bảng trạng thái trong file plan dùng chung (các nhánh
  conflict khi merge); coordinator cập nhật sau merge.
- Worker tên `w<N>-<việc>`, N theo thứ tự dispatch, không cấp lại; dùng cho mọi báo cáo (cờ:
  `references/orca.md`). Reviewer là một dòng `w<N>-review-w<M>`, tính vào cap.
- Đổi phase, worker hay model sau khi plan duyệt → plan về `draft`, hỏi lại, không báo sau;
  ngoại lệ chạy luôn, báo trong report: giao lại neon theo **Chọn model** (dưới); đổi reviewer, checker
  theo quota (§ 4).
- Manifest chỉ phủ tầng A của worker. Tầng C plan ghi tên thì coordinator chạy theo plan; tầng C
  ngoài plan thì park (`CLAUDE.md` § Irreversible actions). Bot không người không bao giờ mở tầng C.

**Spec** gồm: câu của user; những gì coordinator đang có (link, lỗi, dữ liệu đã thấy, bản đồ của
subagent rà: `file:dòng`, bảng, cột); **thiết kế** của coordinator (hướng làm, hàm, luồng, ca biên,
test phải chứng minh gì); khối `Scope:` (chép đúng dòng manifest của worker đó; ngoài scope thì `ask`);
mục **Nghiệm thu** (kết quả user thấy, chuẩn đối chiếu trỏ đúng path, bằng chứng coordinator sẽ thu);
và yêu cầu:

- trước khi sửa: đọc đúng chỗ thiết kế nêu, query dữ liệu thật trên toàn bộ dữ liệu khi thiết kế dựa
  vào dữ liệu; chỗ code hay dữ liệu mâu thuẫn thiết kế thì gửi qua `ask` (output thô, `file:dòng`) và chờ
  trả lời, không mâu thuẫn thì làm luôn; làm đúng thiết kế, không lập kế hoạch lại;
- kiểm hộp thư giữa lượt: chạy `orca orchestration check --peek` trước mỗi commit, trước một lệnh
  dài, và sau khoảng mỗi 10 lệnh; có tin mới của coordinator thì làm theo tin đó trước, tin đã làm
  theo thì bỏ qua khi thấy lại (`--peek` không đánh dấu đã đọc; worker Chat có nhận tin `send` giữa
  lượt hay không tuỳ bản Orca, xem `references/orca.md`);
- lệnh nặng (build, cả bộ test, cài deps) chạy qua `node ~/.claude/scripts/heavy.cjs -- <lệnh>` (lệnh
  ghép hay có biến môi trường: `-- sh -c '<lệnh>'`; Windows: `-- cmd /c <lệnh>`), để các worker chờ lượt
  slot thay vì build cùng lúc; dev server không qua slot (`references/lessons.md`);
- chép mọi cổng "trước khi mark ready" mà `AGENTS.md`/`CLAUDE.md` của repo đòi;
- mọi path, con số, phản hồi giả lập của API ngoài trỏ được tới nguồn đã đọc, không có thì ghi
  "giả định" tại chỗ; fixture không chứa đường dẫn máy, stack trace hay thời điểm chạy;
- task viết/sửa test, đổi logic, hay chạm hệ thống ngoài, dữ liệu thật, lịch, quyền: trích `ntv-test`
  § 1–3; worker chạy mutation và kiểm thực tế trước review, PR ghi kết quả; coordinator soát ở bước 7.
  Test chặn mặc định side effect ra ngoài (thông báo OS, gửi tin, ghi API); lượt kiểm thật chạy
  trên bản sao state, không bao giờ trên state bản live đọc (`ntv-test` § 2);
- việc dời, tách, gộp hay bỏ phần đang chạy, cả vòng sửa của nó: liệt kê thứ phải giữ nguyên (bộ lọc,
  link, trạng thái) và số nào phải khớp;
- báo cáo nói đã kiểm gì, bằng cách nào, và chưa kiểm gì, vì sao;
- các câu trong mục "Phải nói rõ trong spec" của file model đang dùng;
- worker mở trình duyệt: câu tắt tiếng sau mỗi lần tải trang (`~/.claude/knowledge/browser-debug.md`);
- spec viết tiếng Việt có dấu (`references/lessons.md`).

**Worktree:** mỗi worker một worktree riêng, theo quy ước worktree của repo (`AGENTS.md`/`docs/`),
không có thì `--worktree new-child`; worktree `path:`, Setup Script, port dev server:
`references/orca.md`.

**Song song và cap:** mặc định parallel tới cap (user chốt): mỗi track — nhóm việc chung file nguồn —
một worker, một nhánh, dispatch cùng lúc. Serial chỉ khi user nói, hoặc áp lực bộ nhớ ≥ 2
(`sysctl -n kern.memorystatus_vm_pressure_level`; Windows không có mức áp lực: RAM còn dùng được
`(Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory).AvailableMBytes` (tính cả standby) dưới 20% tổng
(`(Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize`, KB) coi như mức 2, dưới 5% coi như mức 4) mà user chưa cho vượt cap trong phiên (đã cho: chỉ
ngừng giao thêm ở mức 4). Cap là ràng buộc RAM của máy
(`knowledge/orca.md`); "max N" của user là N worker sống cùng lúc xuyên phiên. Đỉnh RAM của lệnh nặng
do slot của `heavy.cjs` chặn (spec, trên). Còn slot và còn việc
đủ điều kiện thì giao ngay, không chờ cả wave. Dòng `# Track:` liệt kê việc và file giúp hook
`dispatch-split-guard` nhắc khi một worker ôm các việc không chung file. Các track phụ thuộc nhau mà repo có cổng chạy toàn bộ
test: worker commit local, coordinator gộp vào nhánh tích hợp, mở PR từ đó. Không `--no-verify`. Các nhánh phải
lên production cùng nhau, hoặc cùng kích hoạt một pipeline deploy/publish tính tiền, cũng gộp như
vậy thành một PR/MR để pipeline chạy một lần: gộp nhánh, không gộp worker — các worker vẫn chạy song song.

**Chọn model** (user chốt; mỗi dòng một file trong `references/models/`):

- Worker builder không dùng model Claude, trừ khi user chỉ định. Reviewer, checker chọn theo quota (§ 4), có
  thể là Claude; review thay đổi của harness hay rule cho agent luôn là Claude (§ 4); chặng rà là
  subagent `ntv-scout` (Sonnet, § 1).
- Builder luôn là Gemini qua Antigravity; codex (GPT) hay Claude chỉ khi user chỉ định. Mọi model
  Gemini trên `agy` chung một quota, nên builder hết quota thì không đổi sang model Gemini khác: đề
  xuất một model thay kèm lý do, user duyệt rồi mới giao.
- **Builder** chọn theo dấu hiệu đọc được trong spec lúc giao, không theo khó/dễ (lúc giao chưa biết):
  - `agy gemini-4-neon high` khi việc có một trong hai dấu hiệu: (1) code mới hay sửa có trạng thái
    lưu giữa các lần chạy (watermark, sổ ghi, bản ghi dở), thử lại, hay ghi ra ngoài repo (Lark,
    issue, DB hay KV nơi khác đọc, API ngoài), cả vòng sửa của việc đó; (2) dời, tách, gộp hay bỏ
    phần đang chạy của giao diện hay luồng dữ liệu.
  - `agy gemini-4-hydrogen high` chỉ cho việc làm trọn trong một lượt, không phải nén context: không
    có dấu hiệu nào ở trên, spec chỉ rõ từng chỗ và kết quả ở mỗi chỗ, và đủ cả ba: chạm tối đa 3
    file trong một module; không viết test hay mutation ngoài một test spec nêu sẵn; không dò code
    ngoài các `file:dòng` spec đưa (đổi một giá trị, sửa docs, sửa 1–2 finding nhỏ). Việc đổi logic
    phải chạy mutation (§ 2, checklist spec) nên luôn là neon.
  - Còn lại → neon, kể cả vòng sửa theo finding chạm từ 4 file hay 2 module, cần test đỏ cho nhiều
    ca, hay mutation; spec chưa chốt hết kết quả cũng neon. Vòng sửa không bao giờ hạ model của
    builder gốc: việc gốc neon thì vòng sửa neon.
  - Dòng manifest của worker ghi model và dấu hiệu đã khớp (`w5-tach-trang (agy gemini-4-neon high ·
    dấu hiệu 2)`); không khớp dòng nào thì ghi vì sao.
- **Builder trượt review hai vòng** trên cùng một thiết kế đã duyệt: hydrogen → giao lại neon; neon →
  park track, Report kèm findings hai vòng và đề xuất của coordinator (thường là sửa thiết kế hay
  spec). Carbon, argon làm builder hay reviewer chỉ khi user chỉ định.
- Không giao task dài cho model context ngắn (`gpt-luna`): chia task nhỏ, mỗi task một worker mới,
  commit + push mỗi nhóm việc ≤ 30 phút.
- Truyền model, slug và effort: `references/orca.md`.

## 3. Trong lúc chạy

- **Giao xong thì kết thúc lượt; Orca đánh thức** khi worker `worker_done`, hỏi, hay dừng không báo
  (`escalation`). Không chạy vòng poll hay script nào đọc `check` (`references/orca.md`). Mỗi lần được
  đánh thức: chạy đúng lệnh `check` của lời nhắc, xử lý mọi tin. Báo và hỏi user một
  lần cho cả khối (một AskUserQuestion, mọi bản nháp trên chat ngay trước nó), khi không còn worker hay bước nào của khối
  chạy được mà thiếu câu trả lời; mục gấp hay quyết định nghiệp vụ giữa khối cũng chờ tới lúc đó,
  vì ask đang mở làm cả phiên đứng. Riêng việc theo dõi treo:
  `watch.sh` với `~/.claude/scripts/worker-stall.cjs` (receipt của `worker-start` in sẵn lệnh; nó không
  đọc `check`), vì worker lặp lỗi API hay đứng im thì Orca không đánh thức.
- **Trả lời `ask` ngay.** Worker hỏi vì thiếu quyền hay credential → trả lời bằng đường đã ghi trong
  `AGENTS.md`/`docs/` của repo, không chạy hộ. Ngoại lệ: lệnh ghi production là việc của coordinator.
- **Session worker là tài sản** (~30–60k token nạp). Việc kế tiếp cụ thể cần đúng context của worker
  đó và tới trong TTL cache (codex 30 phút, Claude 1 giờ) → giao tiếp cho chính worker đó, cách giao
  theo trạng thái của nó ở `references/orca.md`. Việc định giao tiếp như vậy phải xét lại **Chọn
  model** (§ 2) như một lần giao mới: khác loại task, hoặc làm task vượt mức § 2 cho model context
  ngắn → worker mới (ngoài manifest đã duyệt thì hỏi lại, § 2). Đừng để worker release rồi vài phút sau
  spawn lại; cũng đừng giữ "phòng khi cần".
- **Worker im lâu:** đọc `worker-read --source transcript` hai lần cách nhau vài phút trước khi kết
  luận. Im lặng, timeout hay `unverifiable` không bao giờ đủ để tự dừng, bỏ hay chạy lại worker
  (guide). Worker còn sống thì nó vẫn là người sửa duy nhất của worktree.

## 4. Cổng

**Review.** Diff logic từ 30 dòng (trừ test, doc, lockfile), hoặc task chạm tiền, thư gửi khách, dữ
liệu người khác đọc, UI hay BI → có reviewer trước khi merge, dù tác giả là worker hay coordinator.

- **Độc lập là bắt buộc:** context mới, không phải phiên của tác giả hay fork của nó; nhận diff, Scope,
  mục Nghiệm thu và các câu hỏi cố định, không nhận hội thoại, lập luận hay báo cáo của tác giả; brief
  không gợi kết luận.
- **Model theo quota lúc giao:** còn quota ở model khác dòng với tác giả thì dùng (agy `gemini-4-neon
  high`, Codex `sol high`); không thì model nào còn quota; hết cả thì một Claude context mới (subagent
  hay worker Claude). Đọc quota: agy `agy -p "/usage"` (dòng `Gemini Models`); Codex `rate_limits`
  (`primary` 5 giờ và `secondary` tuần: `used_percent`, `resets_at`) ở log phiên mới nhất dưới `~/.codex/sessions/`; không đọc được
  thì giao, gặp lỗi hết quota thì chuyển model kế. Đổi theo quota làm luôn, ghi vào report. Reviewer ở mọi model, mọi vòng chạy effort high, dù
  frontmatter của model ghi gì. **Checker** theo cùng luật; khi là agy: `gemini-4-hydrogen high`.
- **Thay đổi harness hay rule cho agent** (`~/.claude`, repo nguồn cài ra nó, `.claude/` hay
  `CLAUDE.md`, `AGENTS.md` của một repo), dù ai viết: reviewer là một Claude subagent context mới, effort
  high — chỉ agent chạy harness này đọc được hợp đồng của hook và cách một luật được hiểu. Brief nêu
  các lệnh agent thật sự gõ, không săn đường vòng qua hook (`ntv-kaizen`).
- **Đường nhạy cảm** (tiền, quyền truy cập, dữ liệu riêng tư, migration, tin gửi khách): hai reviewer
  độc lập chạy song song, khác model khi quota cho phép.
- Docs: phần kể lại một sự cố hay cuộc điều tra không cần reviewer; phần nói một dự án hay code của nó
  chạy thế nào, hay cách vận hành nó, được review đối chiếu với code đó.

Reviewer nhận diff, Scope, mục Nghiệm thu và hai câu hỏi cố định: lượt chạy xấu nhất (số
item tối đa × thời gian đo trên lần chạy thật) có lọt trần thời gian của runtime không; và tiến trình
nào khác (nút bấm, lịch, webhook) ghi hay gửi cho cùng bản ghi trong cùng khoảng thời gian. Spec reviewer đòi dán nguyên findings kèm output
thô và `file:dòng`; finding coordinator tự gửi worker cũng dẫn `file:dòng` cả nơi sinh lẫn nơi đọc
giá trị, hoặc kèm một ca chạy thật. Phạm vi reviewer cố định (user chốt): diff, hai câu hỏi trên và
bằng chứng; vòng 1 là lượt duy nhất đọc cả diff và báo mọi thứ thấy, không lọc theo mức độ trừ khi user
yêu cầu; mutation chỉ kiểm lại một module tác giả đã báo, đo một lượt chạy thật trên bản sao state
(`ntv-test` § 2); vòng 2 chỉ đọc bản sửa (diff từ SHA vòng 1 tới SHA mới, cộng chỗ đọc hay ghi giá trị
mà bản sửa đổi), trả lời mỗi finding đã sửa đúng chưa và bản sửa có làm sai chỗ nó chạm không (hai câu
hỏi cố định chỉ hỏi lại khi bản sửa chạm tới chúng), chỉ liệt kê lỗi chặn merge. Coordinator quyết từng
finding và đối chiếu ít nhất một bằng chứng với nguồn thật; PASS của reviewer chỉ là đầu vào; trên việc
coordinator tự làm, finding không sửa thì đưa user xem kèm lý do, không tự gạt. **Tiêu chí dừng:** chỉ
finding làm sai output thật khi dùng bình thường mới chặn merge; còn lại ghi "giới hạn đã biết" vào PR.
Sau khi thiết kế ổn định tối đa 2 vòng review; builder trượt cả hai thì theo **Chọn model** (§ 2).

**Nghiệm thu** — user chỉ nhận bản đã qua nghiệm thu:

- Bắt đầu từ sản phẩm, không từ báo cáo của người làm; mặc định còn ít nhất một lỗi chưa ai thấy.
- Bước kiểm chính phải đỏ được trên bản base.
- Checker độc lập (agent mới, không phải tác giả; model theo luật reviewer) chạy các bước kiểm cơ học
  khi task có logic mới; nhận mục Nghiệm thu, không nhận báo cáo của tác giả; mỗi mục một kết luận kèm
  bằng chứng. Task nhỏ (sửa chữ, đổi một tham số) → coordinator tự kiểm.
- UI: chụp desktop và mobile cạnh màn mẫu. Data: so số dòng và tổng theo từng nhóm khoá với nguồn.
  BI: tự tính lại 2–3 con số từ nguồn bằng query riêng; bố cục đọc từ file định nghĩa.
- Đúng logic mà lệch chuẩn là chưa xong: trả về người làm kèm bằng chứng chỗ lệch.
- Một mục trượt trên đường nhạy cảm (tiền, gửi thư, dữ liệu người khác đọc) chặn cả khối.

**Merge và production** (`ntv-implement` § Ship): coordinator đọc toàn bộ diff từ lần đọc trước tới
đúng SHA sẽ merge và chạy check của repo trên SHA đó. "Đã deploy/đã ghi" chỉ nhận khi đọc lại đích
(n8n: workflow trên instance; DAG: trạng thái task). Lệnh ghi production không giao worker (§ 1).

**Gate và ship theo đợt** (repo mà push lên nhánh chính là deploy; `references/lessons.md`):

- Trước gate, head phải chứa base mới nhất (`git merge-base --is-ancestor origin/<base> <head>`); thiếu
  thì trả người làm merge base rồi gate lại.
- Đọc test nào thật sự đã chạy (số ca, file được chọn), không chỉ exit code.
- Gộp các PR sẵn sàng lên một nhánh local từ base mới nhất, test một lần, kết luận từng PR; PR conflict
  chỉ bỏ PR đó, phần còn lại vẫn đi.
- Đóng băng đợt lúc bắt đầu check: PR tới sau vào đợt kế. Trước khi đóng băng, không PR nào trong đợt
  chứa head đang giữ lại (`git merge-base --is-ancestor <head-giữ> <head-PR>`).
- Mỗi đợt một lần push lên nhánh chính, qua một PR/MR tích hợp, để pipeline deploy chạy một lần.

## 5. Chế độ không người

Bot chạy liên tục là coordinator không có user. Việc nó được làm là `AGENTS.md § Phạm vi tự chủ` của
repo đích giao với scope trong `CLAUDE.md` của bot. Không bao giờ mở tầng C; gặp thứ ngoài
policy → park, báo qua kênh của bot, làm item tiếp theo. Chỉ sinh worker khi có từ 2 item chạy song
song.

## 6. Khi có sự cố

Trạng thái Orca báo là claim của Orca; sự thật lấy từ thứ không đi qua Orca (`git -C <worktree> log`,
`git status --short`, PR, transcript của worker). Bảng triệu chứng và cách xử lý: `references/orca.md`
§ Khi có sự cố.

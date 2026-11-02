---
model: luna              # dòng model; slug = bản luna mới nhất trong catalog codex (Rule 18). Orca 1.4.207–1.4.220 chưa biết gpt-6-luna → KHÔNG truyền --model/--effort, xem thân file
agent: codex             # truyền vào --agent
effort: max
ui: tệ                   # tốt | được | tệ | chưa rõ
backend: được            # tốt | được | tệ | chưa rõ
speed: nhanh             # nhanh | vừa | chậm | chưa rõ
source: 2 phiên (phễu quiz — 13 commit, không lần nào respawn; hệ thống hoá đơn — 3 worker, 3 PR) + kinh nghiệm user (codex làm UI tệ; luna làm backend được, nhanh, giá ~1/25 Opus nhưng không bằng flagship)
---

# gpt-luna

Luna là dự phòng: task cỡ trung bình dùng `gemini-flash`, chỉ khi `gemini-flash` hết quota
mới dùng luna (user chốt, `../../SKILL.md` § Chọn model theo loại việc).

Luna 6 thay `gpt-5.6-luna`. Các nhận định `(N phiên)` dưới đây ghi
từ bản 5.6. Phiên đầu của bản 6 xác nhận hay bác bỏ nhận định nào thì sửa nhận định đó.

Nhận định ghi `(N phiên)`; phiên sau xác nhận thì tăng số, bác bỏ thì sửa hoặc xoá.
Frontmatter đổi theo.

## Spawn

Orca 1.4.207 từ chối `--model gpt-6-luna --effort max` vì bảng model của nó chưa có bản 6.
Vẫn đúng ở 1.4.220 (`app.asar`): bảng codex chỉ có `gpt-5.6-*`, model lạ
chỉ nhận effort tới `xhigh`.
Catalog codex thì ghi rõ bản 6 hỗ trợ `max`. Cách spawn:
- `worker-start --agent codex`, **không** kèm `--model`/`--effort`.
- Model và effort lấy từ `~/.codex/config.toml`: `model = "gpt-6-luna"`,
  `model_reasoning_effort = "max"`.
- Đọc `terminal read --screen` sau spawn: header và thanh trạng thái phải ghi
  `GPT-6-Luna max`. Vài giây đầu thanh trạng thái ghi `default` vì chưa nạp xong config,
  nên phải đọc lại.
- `settings.agentDefaultArgs.codex` của Orca rỗng, và codex do
  Orca mở đọc `~/.codex` (kiểm bằng `lsof`), không đọc `codex-runtime-home`. Lần
  `worker-start` thử: receipt ghi `launch.effective.model = null`, argv là `codex`
  trần, màn hình ghi `GPT-6-Luna max`. Receipt không nói model thật, nên chỉ màn hình là
  bằng chứng.

Khi Orca nhận bản 6 (`--effort max` không còn bị từ chối), quay lại truyền cờ explicit như Rule 18.

## Chọn Luna hay coordinator tự làm

Luna nhanh và rẻ nhưng năng lực không bằng flagship (user chốt).

- **Task đơn giản** — gói gọn, spec rõ, ít file (sửa text, thêm bộ lọc báo cáo): giao
  Luna làm một mình, không cần kèm sát. Trừ UI/UX. (2 phiên)
- **Task khó** — logic trải nhiều workflow, nhạy về an toàn (gửi thư, phát hành hoá
  đơn, công nợ): kèm chặt — duyệt thiết kế trước khi code, review diff thật qua reviewer cùng model
  (`../coordinator-rules.md` § Review trước `worker_done`). Trước khi
  giao, cân cost: Luna + coordinator duyệt thiết kế, review, làm chặng cuối so với
  coordinator tự làm. Ở một task khó, coordinator chỉnh 3 điểm thiết kế, bắt 2 bug, tự
  commit/push/mở PR — phần kèm gần bằng việc tự làm. (1 phiên)

## Giao gì

- Backend, data pipeline, SQL, schema. Mỗi việc xong trong 3–12 phút. (1 phiên)
- Task gọn làm một lượt là xong: đổi xưng hô email (87/87 test, `workflow.json` sinh
  lại khớp từng byte); lọc CNĐK theo ngày thanh toán bằng cách tái dùng cổng lọc có
  sẵn. (1 phiên)
- Tự làm đúng những chi tiết không ai dặn: chốt chặn keyset pagination
  `if next_cursor == cursor: raise`, trung vị SQL đúng cả n chẵn lẫn lẻ, qualify
  schema bằng `{DATABASE}` ở mọi câu, `COALESCE(NULLIF(TRIM(label),''), key)`.
  (1 phiên)
- Bắt lỗi concurrency: tự thấy hai lượt chạy song song gửi trùng thư, sửa bằng CAS
  filter — coordinator không nhìn ra. (1 phiên)
- Kỷ luật ranh giới: không lần nào lấn sang tầng B/C, báo cáo tự ghi phần chưa
  chạy prod. (1 phiên)

## Không giao gì

- UI/UX. (kinh nghiệm user)
- Việc mà thiết kế chưa kiểm bằng dữ liệu thật. Luna không phản biện spec — spec
  sai thì implement sai một cách trung thành: khoá biến thể ghép sai đi qua hai
  commit trước khi coordinator tự phát hiện; một thiết kế khác định dùng
  một trường log bị cắt đầu khi quá dài làm khoá chống trùng. (2 phiên)

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. **Thông tin đi đúng kênh spec đòi, không hơn.** Spec đòi báo cáo cho coordinator
   nên nó viết đầy đủ ở báo cáo `worker_done` (commit hash, số test, quyết định
   thiết kế); spec không đòi thân commit nên 11/11 commit chỉ có tiêu đề.
   Coordinator xác nhận trong phiên. Báo cáo là kênh tạm, commit là kênh bền — muốn
   lý do sống trong repo thì spec phải đòi. (1 phiên)

       Commit message phải có phần thân giải thích vì sao, kèm số liệu thật nếu quyết định dựa trên dữ liệu; tiêu đề trống ruột là chưa xong việc.

2. **Sửa cục bộ, không lùi lại nhìn cấu trúc.** Được bảo thêm nhánh ALTER cho
   schema, nó chép nguyên 33 dòng định nghĩa cột sang file thứ hai — lỗi DRY sinh
   từ chính bản vá. Nhắc lần hai mới gộp (gọn, giảm 56 dòng). Phiên khác: một danh sách
   trạng thái khai trùng hai nơi, coordinator phải đòi gộp vào một module chung. (2 phiên)

       Trước khi sửa, nói xem bản vá này có tạo nguồn sự thật thứ hai hoặc nhân bản khai báo nào không; nếu có thì đề xuất chỗ gộp.

3. **Khai khoảng trống kiểm chứng khi được đòi.** Phiên 1 dẫn "331 tests passed" làm
   bằng chứng, toàn unit test trên chuỗi SQL sinh ra; lỗi `CREATE TABLE IF NOT
   EXISTS` không thêm được cột vào bảng đã có lọt qua 341 test. Phiên sau tự khai
   thật là chưa kiểm giao diện — chưa rõ spec phiên đó có chèn câu dưới
   không. Cứ chèn. (2 phiên)

       Cuối báo cáo tách hai mục: "Đã kiểm: <cách> → <kết quả>" và "CHƯA kiểm: <điều gì> — <lý do>". Việc nào tự kiểm được trong scope thì kiểm xong mới báo; "CHƯA kiểm" chỉ dành cho việc scope cấm (dữ liệu prod, thao tác tầng B/C) hoặc cần người làm, không có thì ghi "CHƯA kiểm: không có".

4. **Không hỏi lại.** Chất lượng đầu ra bị chặn trên bởi chất lượng spec — kiểm
   thiết kế bằng dữ liệu trước khi giao (`../coordinator-rules.md`
   § Kiểm trước khi giao). Không có câu chèn nào thay được bước này.

5. **Chặng git yếu.** Commit trước khi đọc tin review; commit message
   dính `\n\n` literal thay vì xuống dòng; guard sandbox chặn `git add` file
   `_shared/` thì đề xuất revert — vứt phần sửa đúng; bỏ worktree rebase dở, không
   push trong 8 phút, coordinator phải dừng và làm nốt. (1 phiên)

       Trước mỗi commit, đọc tin mới nhất của coordinator. Bị chặn khi stage/commit/push thì giữ nguyên thay đổi, báo lệnh bị chặn qua ask — không revert, không rebase dở dang.

## Review gì sau `worker_done`

- Đọc diff, không đọc báo cáo: báo cáo đủ nhưng không nói chỗ chưa kiểm.
- **Hai đường phải cư xử giống nhau:** khi cùng một hậu quả đi được bằng hai đường
  (nút Lark và ký trên portal), đặt hai đường cạnh nhau trên từng nhánh. Ví dụ: fallback
  `tongMoi || soCu` khiến tổng mới = 0 thì đường Lark gửi thư báo chênh còn đường
  portal im lặng — self-review của Luna không bắt được. (1 phiên)
- **Mode chỉ-đọc không được có side effect:** một lượt chỉ-đọc vẫn chuyển tiếp
  event phía sau — đọc Lark 5 lần, có thể sinh job PDF. (1 phiên)
- Tìm lỗi DRY sinh ra từ chính bản vá — khai báo nhân đôi, nguồn sự thật thứ hai.
- DDL/SQL: không tin số test. Dựng `probe_*`, chạy thật trên DB, đối chiếu, `DROP`
  trong cùng lượt. Soát riêng `CREATE TABLE IF NOT EXISTS` trên bảng đã tồn tại.
- Commit thiếu thân hoặc dính `\n` literal → giao lại sửa trước khi merge.

## Cách nó giao tiếp, và kẹt ở đâu

- Không đặt câu hỏi nào suốt phiên: không treo chờ coordinator, nhưng cũng không
  báo khi spec có vấn đề. (1 phiên)
- Báo cáo `worker_done` dài: commit hash, số test, quyết định thiết kế, việc còn
  treo. (1 phiên)
- Kẹt ở chặng git cuối (rebase, stage file ngoài scope, push): lường trước, poll
  `git -C <worktree> status` và sẵn sàng vào thay theo Rule 14 của `SKILL.md`.
  (1 phiên)

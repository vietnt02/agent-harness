---
model: gemini-flash      # dòng model; slug = bản flash mới nhất trong `agy models`, bỏ đuôi effort (`../antigravity.md`)
agent: antigravity       # truyền vào --agent
effort: high
ui: chưa rõ              # tốt | được | tệ | chưa rõ
backend: được            # tốt | được | tệ | chưa rõ
speed: nhanh             # nhanh | vừa | chậm | chưa rõ
source: 1 phiên (port job data pipeline — 2 worker gemini-3.8-flash high song song, 2 MR, CI xanh, không respawn)
---

# gemini-flash

Nhận định ghi `(N phiên)`; phiên sau xác nhận thì tăng số, bác bỏ thì sửa hoặc xoá.
Frontmatter đổi theo.

## Khi nào dùng

Task cỡ nhỏ đến trung bình luôn dùng flash (user chốt). Flash hết quota mới chuyển
`gpt-luna`.

Quota Gemini dư, quota Claude mới khan: 7 worker flash (code, reviewer, checker) chạy cả buổi
chiều chưa tới 1% quota tuần. Đọc diff, dựng server, chụp màn, đối chiếu mockup, chạy
test giao cho worker/checker flash; coordinator Claude đọc kết luận kèm bằng chứng và tự nhìn
bằng chứng cùng tầng ở bước phán xét cuối.

## Spawn

Orca nhận thẳng `--agent antigravity --model <slug trần> --effort high`, ví dụ
`--model gemini-3.8-flash --effort high`. Lấy slug từ `agy models` lúc dispatch, đừng chép số
version từ file này. Cú pháp chung, các lỗi của `agy` và cách kiểm model thật:
`../antigravity.md`.

Không giao task dài: `SKILL.md` Rule 18 § Chọn model theo loại việc.

## Giao gì

- Backend, data pipeline cỡ vừa có khuôn sẵn trong repo để bám: ingest Lark → Postgres +
  `dbt_pg`; port workflow n8n sang automation khi có bản live để đối chiếu. Mỗi task 10–25
  phút. Cùng phiên, worker `gpt-6-luna max` làm task cỡ tương đương chưa xong sau 30 phút.
  (1 phiên)
- Dùng lại helper và macro có sẵn thay vì tự viết (`lark_field`, `safe_bigint`,
  `lark_base_snapshot`); tự giữ đúng ngữ nghĩa giờ của legacy dù spec chỉ dặn một câu.
  (1 phiên)
- Dừng hỏi đúng chỗ: chạm file ngoài scope thì hỏi một lần, kèm phương án. (1 phiên)

## Không giao gì

- Việc dài làm bằng mắt (cắt 21 khung tranh): im 25+ phút, không commit dần, ra 21
  khung hỏng. Phải giao thì cắt nhỏ, spec bắt commit theo mốc và có cổng máy (OCR `tesseract`
  dò chữ lọt), không chỉ contact sheet thu nhỏ. (1 phiên)

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec` (cũng có trong `~/.gemini/config/AGENTS.md`)

Các quy tắc dưới có trong `~/.gemini/config/AGENTS.md`, mà worker chat chỉ nạp được qua symlink
`config` (`../antigravity.md` § Chat chạy runtime agy của Orca) và hook không chạy trong chat. Câu 1 và 2
luôn chép vào `--spec`; câu 3–5 chép khi task chạm commit, fixture hoặc cổng kiểm tương ứng. Lý do:
Flash làm chặt phần có test/CI chặn nhưng dễ lỏng ở quy ước văn bản không gì chặn (một worker viết
commit tiếng Việt không dấu trong repo có 15/15 commit gần nhất tiếng Anh — 1 phiên):

1. Câu trong `../antigravity.md` § Quyền và Policy Guardian (lệnh bị chặn thì báo qua ask).
2. Báo cáo:

       Báo cáo worker_done viết tiếng Việt, mở đầu bằng "Đã kiểm: <cách> → <kết quả>". Việc nào tự kiểm được trong scope thì kiểm xong mới báo. Chỉ ghi "CHƯA kiểm: <điều gì> — <lý do>" cho việc scope cấm (dữ liệu prod, thao tác tầng B/C) hoặc cần người làm; không có thì ghi "CHƯA kiểm: không có".

3. Commit:

       Commit message theo đúng quy ước của repo (xem git log origin/main); repo viết tiếng Anh thì viết tiếng Anh.

4. Fixture (task ingest/model): worker tự dựng payload mẫu theo hình dung, không theo nguồn thật.
   Một worker để cột text `Record ID` của Lark là chuỗi trong fixture, trong khi Lark trả mảng
   `[{"text": …}]`; test xanh, gold lưu nguyên JSON. (1 phiên)

       Payload mẫu trong test chép đúng shape của một bản ghi thật (bronze hoặc response API đã có trong repo); cột nào không có mẫu thật thì báo coordinator, đừng tự đoán shape.

5. Cổng kiểm: khi cổng đỏ, Flash đề xuất allowlist hoặc ghi nhận lỗi vào test để cổng xanh.
   (1 phiên)

       Không thêm allowlist, ngoại lệ hay "lỗi đã biết" vào test hoặc cổng kiểm để nó xanh, không đổi ngưỡng MIN_*; cổng đỏ thì sửa nguyên nhân hoặc báo coordinator.

## Review gì sau `worker_done`

Đừng dựa vào báo cáo để biết thứ chưa kiểm. Tự kiểm ở đúng tầng của claim: dữ liệu thật
trong bảng đích so với nguồn, quyền đọc của consumer trên bảng mới, ngữ nghĩa giờ.

"CI xanh" không chứng minh test mới đã chạy: job có thể chạy một danh sách file cố định hoặc
skip khi thiếu biến môi trường. Mở log job, thấy tên file test mới và số test pass mới tính.
Một worker báo test Postgres "chạy được" và "CI 4/4 xanh" trong khi file đó chưa từng nằm
trong job nào. (1 phiên)

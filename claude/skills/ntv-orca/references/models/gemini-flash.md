---
model: gemini-flash
agent: antigravity
effort: high
ui: chưa rõ
backend: được
speed: nhanh
source: 1 phiên (2 worker gemini-3.8-flash high song song, 2 MR, CI xanh)
---

# gemini-flash

Mặc định cho worker/checker ở task nhỏ–vừa; hết quota mới dùng `gpt-luna` (`SKILL.md` § 2). Spawn: `--agent antigravity --model <slug trần> --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Backend, data pipeline vừa có khuôn sẵn (ingest API, dbt, port workflow có bản live đối chiếu); chạy kiểm cơ học làm checker (`SKILL.md` § 4). Tái dùng helper/macro; dừng `ask` khi chạm ngoài scope.
- **Không giao:** Task dài hoặc căn chỉnh bằng mắt nhiều bước (đầy context 256K tự nén làm quên spec, bịa số liệu); research đọc nhiều tài liệu, tổng hợp nhiều nguồn (giao `gemini-argon`). Chia task ≤ 30 phút kèm cổng máy (`SKILL.md` § 2).

## Phải nói rõ trong spec

Kèm câu lệnh bị chặn ở `../antigravity.md`:

      Báo cáo worker_done viết tiếng Việt, mở đầu bằng "Đã kiểm: <cách> → <kết quả>". Việc nào tự kiểm được trong scope thì kiểm xong mới báo. Chỉ ghi "CHƯA kiểm: <điều gì> — <lý do>" cho việc scope cấm (dữ liệu prod, thao tác tầng B/C) hoặc cần người làm; không có thì ghi "CHƯA kiểm: không có".

      Commit message theo đúng quy ước của repo (xem git log origin/main); repo viết tiếng Anh thì viết tiếng Anh.

      Payload mẫu trong test chép đúng shape của một bản ghi thật (bronze hoặc response API đã có trong repo); cột nào không có mẫu thật thì báo coordinator, đừng tự đoán shape.

      Không thêm allowlist, ngoại lệ hay "lỗi đã biết" vào test hoặc cổng kiểm để nó xanh, không đổi ngưỡng MIN_*; cổng đỏ thì sửa nguyên nhân hoặc báo coordinator.

## Review gì

- Duyệt kế hoạch (`SKILL.md` § 1): đối chiếu từng con số với output thô.
- Nghiệm thu (`SKILL.md` § 4): so dữ liệu đích với nguồn, quyền đọc consumer, múi giờ; mở log CI xem tên file test mới và số test pass thật.

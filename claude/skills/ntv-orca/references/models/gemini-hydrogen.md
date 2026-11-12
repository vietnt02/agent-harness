---
model: gemini-hydrogen
agent: antigravity
effort: high
ui: chưa rõ
backend: chưa rõ
speed: chưa đo (Google công bố nhanh gấp 2,5 lần 3.8 Flash ở mức high)
source: chưa có phiên; số liệu từ công bố của Google
---

# gemini-hydrogen

Mặc định làm **worker** và **checker** cho task nhỏ đến trung bình, research gồm cả; task phức tạp giao `gemini-4-carbon` (`SKILL.md` § 2). Reviewer vẫn là `gemini-argon` (`gemini-argon.md`). Spawn: `--agent antigravity --model gemini-4-hydrogen --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Backend, data pipeline, SQL, sửa code kèm chạy test, research vừa, prototype UI, chạy kiểm cơ học làm checker (`SKILL.md` § 4).
- **Không giao:** Quyết định kiến trúc sâu, lỗi khó lần ra nguyên nhân, task phức tạp nhiều bước (giao `gemini-4-carbon`).

## Phải nói rõ trong spec

Kèm câu lệnh bị chặn ở `../antigravity.md`:

      Báo cáo worker_done viết tiếng Việt, mở đầu bằng "Đã kiểm: <cách> → <kết quả>". Việc nào tự kiểm được trong scope thì kiểm xong mới báo. Chỉ ghi "CHƯA kiểm: <điều gì> — <lý do>" cho việc scope cấm (dữ liệu prod, thao tác tầng B/C) hoặc cần người làm; không có thì ghi "CHƯA kiểm: không có".

## Review gì

- Duyệt kế hoạch và nghiệm thu như mọi dòng model (`SKILL.md` § 1, § 4).
- Phiên đầu tiên dùng model này: ghi điểm yếu thấy được vào file này, thay `source`, `ui`, `backend`, `speed` bằng kết quả thật.

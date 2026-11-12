---
model: gemini-hydrogen
agent: antigravity
effort: high
ui: chưa rõ
backend: chưa rõ
speed: chưa đo (Google công bố nhanh gấp 2,5 lần 3.8 Flash ở mức high)
source: chưa có phiên; số liệu từ công bố của Google (https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity)
---

# gemini-hydrogen

Mặc định làm **worker** và **checker** cho task nhỏ đến trung bình, research nhỏ đến trung bình gồm cả; task và research phức tạp giao `gemini-4-carbon` (`SKILL.md` § 2). Reviewer vẫn là `gemini-argon` (`gemini-argon.md`). Spawn: `--agent antigravity --model gemini-4-hydrogen --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Backend, data pipeline, SQL, sửa code kèm chạy test, research vừa, prototype UI, chạy kiểm cơ học làm checker (`SKILL.md` § 4).
- **Không giao:** Quyết định kiến trúc sâu, lỗi khó lần ra nguyên nhân, task phức tạp nhiều bước (giao `gemini-4-carbon`).

## Phải nói rõ trong spec

Chỉ câu lệnh bị chặn ở `../antigravity.md`.

## Review gì

- Duyệt kế hoạch và nghiệm thu như mọi dòng model (`SKILL.md` § 1, § 4).
- Phiên đầu tiên dùng model này: ghi điểm yếu thấy được và kết quả thật cho `source`, `ui`, `backend`, `speed` qua kaizen (`ntv-kaizen`).

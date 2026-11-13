---
model: gemini-hydrogen
agent: antigravity
effort: high
ui: chưa rõ
backend: chưa rõ
speed: nhanh (1 phiên: dựng một precheck Python 6–23 phút, sửa sau review 9–14 phút)
source: 1 phiên (3 PR một repo Python, cùng spec với carbon); công bố của Google: https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity
---

# gemini-hydrogen

Mặc định làm **worker** và **checker** mọi mức độ, research gồm cả; `gemini-4-carbon` chỉ khi user chỉ định hoặc hydrogen hỏng hai lần trên cùng thiết kế (`SKILL.md` § 2). Reviewer vẫn là `gemini-argon` (`gemini-argon.md`). Spawn: `--agent antigravity --model gemini-4-hydrogen --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Backend, data pipeline, SQL, sửa code kèm chạy test, research vừa, prototype UI, chạy kiểm cơ học làm checker (`SKILL.md` § 4).
- **Điểm yếu:** Bám spec, gửi thiết kế trước khi sửa, nhưng vòng 1 vẫn lọt lỗi logic biên (timeout, rớt tin, nhân đôi) — sửa gọn trong một vòng. Không tự chặn side effect trong test (gọi `osascript` thật) nếu spec không đòi.

## Phải nói rõ trong spec

Chỉ câu lệnh bị chặn ở `../antigravity.md`.

## Review gì

- Duyệt kế hoạch và nghiệm thu như mọi dòng model (`SKILL.md` § 1, § 4).
- Spec luôn kèm câu chặn side effect trong test (`SKILL.md` § 2).

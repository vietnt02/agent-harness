---
model: gemini-hydrogen
agent: antigravity
effort: high
ui: được (vòng sửa theo finding sạch; vòng đầu dời, tách giao diện sót hệ quả)
backend: được (sửa code kèm test; job có trạng thái chưa đo, giao neon)
speed: nhanh (builder ~14 phút mỗi lượt; dựng một precheck Python 6–23 phút, sửa sau review 9–14 phút)
source: 2 phiên (3 PR một repo Python, cùng spec với carbon; 5 lượt builder giao diện và job, cùng phiên với neon); công bố của Google: https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity
---

# gemini-hydrogen

Làm **builder** khi spec khớp dòng hydrogen ở `SKILL.md` § 2 **Chọn model**, và làm **checker** (`SKILL.md` § 4). Reviewer là `gemini-neon` (`gemini-neon.md`). Spawn: `--agent antigravity --model gemini-4-hydrogen --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Việc khớp dòng hydrogen ở `SKILL.md` § 2 (sửa mà spec chỉ rõ từng chỗ và kết quả, cả vòng sửa theo finding; thêm mới không đổi hành vi phần đang chạy; docs; research), chạy kiểm cơ học làm checker (`SKILL.md` § 4).
- **Điểm yếu:** Bám spec, gửi thiết kế trước khi sửa, nhưng vòng 1 vẫn lọt lỗi logic biên (timeout, rớt tin, nhân đôi) — sửa gọn trong một vòng. Vòng đầu dời, tách giao diện sót hệ quả (mất bộ lọc, mất dòng con, lệch số), nên loại việc đó giao neon; vòng sửa theo finding thì sạch. Không tự chặn side effect trong test (gọi `osascript` thật) nếu spec không đòi.

## Phải nói rõ trong spec

Chỉ câu lệnh bị chặn ở `../antigravity.md`.

## Review gì

- Duyệt kế hoạch và nghiệm thu như mọi dòng model (`SKILL.md` § 1, § 4).
- Spec luôn kèm câu chặn side effect trong test (`SKILL.md` § 2).

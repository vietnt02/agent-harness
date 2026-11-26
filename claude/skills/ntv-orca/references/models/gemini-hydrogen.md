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

Làm **builder** khi spec khớp dòng hydrogen ở `SKILL.md` § 2 **Chọn model**, và làm **checker** khi chọn agy theo quota (`SKILL.md` § 4). Reviewer khi chọn agy là `gemini-neon` (`gemini-neon.md`). Spawn: `--agent antigravity --model gemini-4-hydrogen --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Việc khớp dòng hydrogen ở `SKILL.md` § 2: làm trọn trong một lượt, không phải nén context (tối đa 3 file trong một module, không thêm test hay mutation ngoài một test spec nêu, không dò code ngoài `file:dòng` spec đưa; như đổi một giá trị, sửa docs, sửa 1–2 finding nhỏ); chạy kiểm cơ học làm checker (`SKILL.md` § 4).
- **Không giao:** Vòng sửa chạm từ 4 file, nhiều ca test đỏ hay mutation: một vòng như vậy đã phải nén context giữa chừng; giao neon.
- **Điểm yếu:** Bám spec, gửi thiết kế trước khi sửa, nhưng vòng 1 vẫn lọt lỗi logic biên (timeout, rớt tin, nhân đôi) — sửa gọn trong một vòng. Vòng đầu dời, tách giao diện sót hệ quả (mất bộ lọc, mất dòng con, lệch số), nên loại việc đó giao neon; vòng sửa theo finding thì sạch. Không tự chặn side effect trong test (gọi `osascript` thật) nếu spec không đòi.

## Phải nói rõ trong spec

Chỉ câu lệnh bị chặn ở `../antigravity.md`.

## Review gì

- Đối chiếu thiết kế và nghiệm thu như mọi dòng model (`SKILL.md` § 1, § 4).
- Spec luôn kèm câu chặn side effect trong test (`SKILL.md` § 2).

---
model: gemini-neon
agent: antigravity
effort: high
ui: chưa đo
backend: tốt (job có trạng thái, thử lại: lần đúng nguyên nhân gốc; vòng đầu xử lý lỗi quá rộng)
speed: chậm (builder ~25 phút mỗi lượt, ~1,8 lần hydrogen); giá ~1,5 lần hydrogen
source: 1 phiên (4 lượt builder job có trạng thái, cùng phiên với 5 lượt hydrogen)
---

# gemini-neon

Làm **builder** khi spec khớp dòng neon ở `SKILL.md` § 2 **Chọn model** (cả việc không khớp dòng nào), và làm **reviewer** khi chọn agy theo quota (`SKILL.md` § 4). Spawn: `--agent antigravity --model gemini-4-neon --effort high` (`../antigravity.md`).

## Giao gì / Không giao gì

- **Giao:** Việc khớp dòng neon ở `SKILL.md` § 2 (trạng thái lưu giữa các lần chạy, thử lại, ghi ra ngoài repo; dời, tách, gộp hay bỏ phần đang chạy); review (`SKILL.md` § 4).
- **Điểm mạnh:** Lần theo nguyên nhân gốc trong logic trạng thái và thử lại, sửa tận gốc chứ không vá từng ca; tự kiểm giả định trên API thật trước khi làm; tự tìm lỗi cùng lớp ngoài finding; tự nghĩ ca biên khi ghi (DB lỗi lúc ghi sổ thì dừng, giữ watermark).
- **Điểm yếu:** Logic xử lý lỗi nó tự thêm ở vòng đầu quá rộng: coi mọi mã lỗi một loại là một nguyên nhân (mọi 403 là repo đã archive, rồi ghi đè bản ghi dở), gộp chung bắt lỗi đọc và bắt lỗi ghi. Chậm ~1,8 lần và đắt ~1,5 lần hydrogen, nên việc khớp dòng hydrogen ở § 2 không giao neon.
- **Làm reviewer:** chưa đo.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

Khi làm builder (kèm câu lệnh bị chặn ở `../antigravity.md`):

      Mỗi nhánh xử lý lỗi mới nêu điều kiện hẹp nhất kèm nguồn (API trả gì, khi nào); bắt lỗi đọc và bắt lỗi ghi tách riêng.

## Review gì

- Đối chiếu thiết kế và nghiệm thu như mọi dòng model (`SKILL.md` § 1, § 4).
- Soát từng nhánh xử lý lỗi nó tự thêm: điều kiện có hẹp đúng nguồn không, có ghi đè bản ghi dở không.

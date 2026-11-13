---
model: gemini-carbon
agent: antigravity
effort: high
ui: chưa rõ
backend: chưa rõ
speed: chậm (effort high: mỗi lượt nghĩ 20–45 giây; cùng spec dựng precheck Python: 55 phút, gấp ~2,4 lần hydrogen)
source: 2 phiên (2 worker rà chỉ-đọc dữ liệu; 1 worker dựng, so cùng spec với hydrogen)
---

# gemini-carbon

Không còn là mặc định: chỉ làm **worker** khi user chỉ định hoặc `gemini-4-hydrogen` trượt review hai vòng trên cùng một thiết kế đã duyệt (`gemini-hydrogen.md`, `SKILL.md` § 2). Reviewer vẫn là `gemini-argon` (`gemini-argon.md`): người chấm khác model với người làm.

## Giao gì / Không giao gì

- **Giao:** Task user chỉ định, hoặc thiết kế đã duyệt mà hydrogen trượt review hai vòng.
- **Không giao / Điểm yếu:** Cùng spec với hydrogen: chậm hơn mà PR còn lỗi làm sập mọi lượt chạy thật, ba lỗi chặn merge, phải đóng PR. Không giao chặng rà chỉ-đọc (việc của subagent rà, `SKILL.md` § 1): không có kế hoạch duyệt trước thì dò rộng ra ngoài đích spec nêu, mỗi lượt nghĩ lâu, viết lại nhiều lần lệnh `python3 -c` hỏng dấu nháy. Không làm reviewer.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. Khi làm worker (kèm câu lệnh bị chặn ở `../antigravity.md`):

       Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

2. Khi làm worker research:

       Mỗi kết luận dẫn nguồn đã mở (URL tài liệu, `file:dòng`, output lệnh dán nguyên); thứ chưa mở được thì ghi "chưa xác minh" ngay tại chỗ.

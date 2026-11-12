---
model: gemini-carbon
agent: antigravity
effort: high
ui: chưa rõ
backend: chưa rõ
speed: chậm (effort high: mỗi lượt nghĩ 20–45 giây)
source: 1 phiên (2 worker rà chỉ-đọc dữ liệu)
---

# gemini-carbon

Mặc định làm **worker** cho task phức tạp, research phức tạp gồm cả; task và research nhỏ đến trung bình giao `gemini-4-hydrogen` (`gemini-hydrogen.md`, `SKILL.md` § 2). Reviewer vẫn là `gemini-argon` (`gemini-argon.md`): người chấm khác model với người làm.

## Giao gì / Không giao gì

- **Giao:** Task phức tạp (nhiều bước, chạy lệnh, sửa code có test chứng minh), research phức tạp (cùng tiêu chí phức tạp ở `SKILL.md` § 2).
- **Không giao / Điểm yếu:** Không giao chặng rà chỉ-đọc (việc của subagent rà, `SKILL.md` § 1): không có kế hoạch duyệt trước thì dò rộng ra ngoài đích spec nêu, mỗi lượt nghĩ lâu, viết lại nhiều lần lệnh `python3 -c` hỏng dấu nháy. Không làm reviewer.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. Khi làm worker (kèm câu lệnh bị chặn ở `../antigravity.md`):

       Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

2. Khi làm worker research:

       Mỗi kết luận dẫn nguồn đã mở (URL tài liệu, `file:dòng`, output lệnh dán nguyên); thứ chưa mở được thì ghi "chưa xác minh" ngay tại chỗ.

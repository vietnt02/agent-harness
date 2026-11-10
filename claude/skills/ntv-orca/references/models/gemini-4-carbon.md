---
model: gemini-4-carbon
agent: antigravity
effort: high
ui: chưa rõ
backend: chưa rõ
speed: chưa rõ
source: chưa có phiên nào; mặc định do user chốt khi model ra mắt
---

# gemini-4-carbon

Mặc định làm **worker** cho task phức tạp và research, và khi `gemini-flash` hết quota (`SKILL.md` § 2). Reviewer vẫn là `gemini-argon` (`gemini-argon.md`): người chấm khác model với người làm.

## Giao gì / Không giao gì

- **Giao:** Task phức tạp (nhiều bước, chạy lệnh, sửa code có test chứng minh), research đọc nhiều nguồn.
- **Không giao / Điểm yếu:** Chưa có quan sát trên repo của user; ghi vào đây sau mỗi phiên. Không làm reviewer.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. Khi làm worker (kèm câu lệnh bị chặn ở `../antigravity.md`):

       Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

2. Khi làm worker research:

       Mỗi kết luận dẫn nguồn đã mở (URL tài liệu, `file:dòng`, output lệnh dán nguyên); thứ chưa mở được thì ghi "chưa xác minh" ngay tại chỗ.

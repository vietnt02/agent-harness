---
model: gemini-argon
agent: antigravity
effort: high
ui: chưa rõ
backend: được
speed: chưa rõ
source: 1 phiên (3 PR repo Python, worker và reviewer cùng model)
---

# gemini-argon

Mặc định làm **Reviewer** (`SKILL.md` § 2, § 4) và cho **Coordinator** khi user mở `agy` trực tiếp (`../antigravity.md`). Chỉ làm worker khi user chỉ định.

## Giao gì / Không giao gì

- **Giao:** Review diff theo Scope và Nghiệm thu (`SKILL.md` § 4); task backend cần đọc kỹ plan, bắt lỗi plan qua `ask` và sửa gọn trong một vòng.
- **Không giao / Điểm yếu:** Làm worker hay viết thừa (bí danh, nhận nhiều kiểu đầu vào, nhánh dự phòng chết, `except Exception` nuốt lỗi), lọt ca biên (`None`, thiếu config, lỗi ghi đĩa) và thêm khoá ngoài hợp đồng. Làm reviewer dễ dãi (PASS sớm, sót lỗi chặn merge) và có thể bịa dòng log hoặc đường dẫn file.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. Khi làm worker (kèm câu lệnh bị chặn ở `../antigravity.md`):

       Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

       Chỉ đúng chữ ký trong thiết kế đã duyệt: không bí danh, không nhận nhiều kiểu đầu vào, không `except Exception`, không thêm khoá ngoài hợp đồng. Có cổng cho từng ca biên: giá trị `None`, khoá cấu hình thiếu, lỗi ghi giữa chừng.

## Review gì

- **Khi làm worker:** cắt nhánh dự phòng thừa, `except Exception` nuốt lỗi, khoá ngoài hợp đồng; kiểm test cho từng ca biên.
- **Khi làm reviewer:** spec reviewer bắt dán nguyên findings kèm output thô (`tail` log) và `file:dòng`. Coordinator tự đọc diff tới SHA sẽ merge và đối chiếu ít nhất một bằng chứng với nguồn thật (`SKILL.md` § 4).

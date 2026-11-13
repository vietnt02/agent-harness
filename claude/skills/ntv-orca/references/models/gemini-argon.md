---
model: gemini-argon
agent: antigravity
effort: high
ui: chưa rõ
backend: được
speed: review vòng 1 14–16 phút khi spec bắt chạy mutation toàn module và đo nhiều lượt; vòng hẹp (chỉ finding đã sửa) 3–6 phút
source: 2 phiên (3 PR repo Python, worker và reviewer cùng model; 4 lượt review PR của hydrogen/carbon)
---

# gemini-argon

Mặc định làm **Reviewer** (`SKILL.md` § 2, § 4) và cho **Coordinator** khi user mở `agy` trực tiếp (`../antigravity.md`). Worker mặc định là `gemini-4-hydrogen` (`gemini-hydrogen.md`); Argon làm worker chỉ khi user chỉ định.

## Giao gì / Không giao gì

- **Giao:** Review diff theo Scope và Nghiệm thu (`SKILL.md` § 4); research cần context lớn (tài liệu ngoài, nhiều nguồn); task backend cần đọc kỹ plan, bắt lỗi plan qua `ask` và sửa gọn trong một vòng.
- **Không giao / Điểm yếu:** Làm worker hay viết thừa (bí danh, nhận nhiều kiểu đầu vào, nhánh dự phòng chết, `except Exception` nuốt lỗi), lọt ca biên (`None`, thiếu config, lỗi ghi đĩa) và thêm khoá ngoài hợp đồng. Làm reviewer dễ dãi (PASS sớm, sót lỗi chặn merge) và có thể bịa dòng log hoặc đường dẫn file; khi spec giữ đúng phạm vi reviewer (`SKILL.md` § 4) thì mọi lượt đều bắt lỗi chặn merge thật, kèm `file:dòng` và số đo.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. Khi làm worker (kèm câu lệnh bị chặn ở `../antigravity.md`):

       Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

       Chỉ đúng chữ ký trong thiết kế đã duyệt: không bí danh, không nhận nhiều kiểu đầu vào, không `except Exception`, không thêm khoá ngoài hợp đồng. Có cổng cho từng ca biên: giá trị `None`, khoá cấu hình thiếu, lỗi ghi giữa chừng.

2. Khi làm worker research:

       Mỗi kết luận dẫn nguồn đã mở (URL tài liệu, `file:dòng`, output lệnh dán nguyên); thứ chưa mở được thì ghi "chưa xác minh" ngay tại chỗ.

## Review gì

- **Khi làm worker:** cắt nhánh dự phòng thừa, `except Exception` nuốt lỗi, khoá ngoài hợp đồng; kiểm test cho từng ca biên.
- **Khi làm reviewer:** spec reviewer bắt dán nguyên findings kèm output thô (`tail` log) và `file:dòng`. Coordinator tự đọc diff tới SHA sẽ merge và đối chiếu ít nhất một bằng chứng với nguồn thật (`SKILL.md` § 4).

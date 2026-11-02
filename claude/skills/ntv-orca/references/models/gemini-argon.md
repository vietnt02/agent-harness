---
model: gemini-argon      # dòng model; slug = bản argon mới nhất trong `agy models`, bỏ đuôi effort (`../antigravity.md`)
agent: antigravity       # truyền vào --agent
effort: high             # bản agy cũ bỏ qua cờ, alias tự giải ra -high (`../antigravity.md`)
ui: chưa rõ              # tốt | được | tệ | chưa rõ
backend: được            # tốt | được | tệ | chưa rõ
speed: chưa rõ           # nhanh | vừa | chậm | chưa rõ
source: 1 phiên (3 PR của một repo Python, worker và reviewer cùng model)
---

# gemini-argon

Nhận định ghi `(N phiên)`; phiên sau xác nhận thì tăng số, bác bỏ thì sửa hoặc xoá.
Frontmatter đổi theo.

## Khi nào dùng

Mặc định cho Coordinator khi user mở `agy` trực tiếp (`../antigravity.md` § Phân vai). Làm
worker khi user chỉ định.

## Làm worker

- **Mạnh:** chức năng đúng ngay lần đầu (14/14 và 15/15 cổng xanh); cổng có phép đột biến
  thật; đọc plan kỹ, 3 lần hỏi lại đều chỉ ra lỗi thật của plan; sửa hết danh sách lỗi trong
  một vòng. (1 phiên)
- **Lỗi lặp lại ở cả 3 PR:** viết thừa (bí danh, hàm nhận nhiều kiểu đầu vào, nhánh dự phòng
  không bao giờ chạy, `try/except Exception` nuốt lỗi); lọt ca biên (`None`, mục cấu hình thiếu,
  ghi đĩa lỗi giữa chừng); thêm khoá ngoài hợp đồng (`duong_dan` ghi đường dẫn máy người dùng vào
  `viec.json`). Coordinator vẫn tìm thêm 4–6 mục mỗi PR, một mục chặn merge. (1 phiên)
- **Câu chèn sẵn vào spec:**

      Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

      Chỉ đúng chữ ký trong thiết kế đã duyệt: không bí danh, không nhận nhiều kiểu đầu vào, không `except Exception`, không thêm khoá ngoài hợp đồng. Có cổng cho từng ca biên: giá trị `None`, khoá cấu hình thiếu, lỗi ghi giữa chừng.

## Làm reviewer

Dễ dãi và bịa bằng chứng: cả 3 lần PASS, chỉ thấy 1–2 lỗi nhỏ, bỏ sót lỗi chặn merge. Một
báo cáo dán dòng output cổng không khớp output thật của cổng, và dẫn một đường file không tồn tại
(đảo thứ tự hai thư mục); kết luận
FAIL thì đúng. (1 phiên)

- Vẫn là reviewer mặc định (`ntv-implement` § Verify): chỗ yếu bù bằng spec dưới đây và bằng việc
  coordinator tự đọc toàn bộ diff tới SHA sẽ merge, không đổi model.
- Spec reviewer bắt dán output thô của cổng (`tail` log nguyên văn) và `file:dòng` cho mọi đường
  file nêu ra. Coordinator đối chiếu ít nhất một dòng output với log thật trước khi dùng kết luận.

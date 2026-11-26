# Bài học — cơ chế đã hỏng → luật

Luật của `ntv-orca` sinh ra từ một chỗ đã hỏng, mỗi luật kèm cơ chế làm nó cần thiết, để áp theo ý
chứ không theo chữ, và gỡ được khi cơ chế không còn. Không tên sự cố, không ngày (`ntv-kaizen`). Đọc
cùng `SKILL.md` trước manifest hay spec đầu tiên của phiên.

## Giao việc

- **Worktree mới chỉ thấy thứ đã push lên ref base** (thường `origin/main`), và không lỗi nào báo khi
  worker dựng trên base cũ → file coordinator soạn dở thì push trước, copy vào worktree, hoặc đưa thẳng
  vào spec (`--spec-file`).
- **Spec không dấu đọc ra nhiều nghĩa**: "dung" là dùng, đừng, đúng hay dựng → spec viết tiếng Việt có
  dấu.
- **Lỗi trích lại đúng chuỗi vừa gõ** (`'luna'`) là sai slug, không phải model thiếu năng lực → slug tra
  lúc dispatch (`references/orca.md`).

## Thiết kế và review

- **Người duyệt plan của người khác bị neo vào cách họ đặt vấn đề**, không thấy phương án họ chưa từng
  nghĩ tới → coordinator tự thiết kế; việc khó đảo ngược thì có thêm một thiết kế độc lập để so
  (`SKILL.md` § 1).
- **Reviewer nhận lập luận hay báo cáo của tác giả thì đi theo lập luận đó** → review độc lập: context
  mới, chỉ nhận sản phẩm, Nghiệm thu và câu hỏi cố định, brief không gợi kết luận (`SKILL.md` § 4).
- **Mỗi reviewer có điểm mù riêng**, và trên đường tiền, quyền, dữ liệu riêng tư một lỗi nặng lọt qua
  một người là đủ gây hại → đường nhạy cảm có hai reviewer độc lập chạy song song, khác model khi quota
  cho phép (`SKILL.md` § 4).

## Máy và ship

- **Đỉnh RAM đến từ các lệnh nặng chạy cùng lúc** (build, cả bộ test, cài deps), còn chờ theo ngưỡng
  tải thì không biết bao giờ tới lượt → lệnh nặng chờ lượt qua slot dùng chung
  (`~/.claude/scripts/heavy.cjs`), slot nhả ngay khi lệnh xong (`SKILL.md` § 2).
- **Dev server hay lệnh watch chạy suốt task**, giữ slot thì chặn mọi lệnh nặng khác tới khi nó tắt → dev
  server và lệnh watch không qua slot; RAM của nó do chốt áp lực bộ nhớ chặn (`SKILL.md` § 2).
- **RAM của máy phụ thuộc loại lệnh worker đang chạy hơn số worker**: nhiều worker chỉ chờ model thì
  nhẹ, vài worker cùng build thì nặng → không cap cố định theo số worker; lệnh nặng qua slot, chỉ ngừng
  giao thêm khi áp lực bộ nhớ ở mức 4 (`SKILL.md` § 2).
- **Mỗi lần push lên nhánh deploy là một lần build production** → mỗi đợt một lần push, qua một PR tích
  hợp (`SKILL.md` § 4).
- **Đợt cứ lớn thêm trong lúc check đang chạy**, nên kết quả check không còn khớp thứ được ship →
  đóng băng đợt lúc bắt đầu check (`SKILL.md` § 4).
- **Bỏ số một PR ra khỏi đợt không bỏ được commit của nó** khi một PR khác dựng trên nó → trước khi
  đóng băng, không PR nào chứa head đang giữ lại (`SKILL.md` § 4).
- **Một bộ lọc test có thể không chọn ca nào mà runner vẫn báo xanh** → đọc test nào thật sự đã chạy,
  không chỉ exit code (`SKILL.md` § 4).

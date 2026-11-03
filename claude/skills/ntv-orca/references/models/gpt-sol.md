---
model: sol
agent: codex
effort: high
ui: tệ
backend: tốt
speed: vừa
source: 1 phiên (2 worker, 5 commit) + kinh nghiệm user
---

# gpt-sol

Chỉ dùng khi user duyệt ở manifest (`SKILL.md` § 2). Spawn: `--agent codex --model <slug> --effort high` (`~/.codex/models_cache.json`).

## Giao gì / Không giao gì

- **Giao:** Backend, pipeline, SQL, dbt vừa–lớn; phản biện spec, bắt PII, sửa nhanh.
- **Không giao:** UI/UX; task dài (context 272K, chia worker, `SKILL.md` § 2).

## Phải nói rõ trong spec

      Model SQL/dbt: chạy EXPLAIN và đo thời gian ở ít nhất 2× cỡ dữ liệu hiện tại; không dùng LATERAL/subquery tương quan quét lại bảng lớn cho mỗi dòng; ghi số đo vào báo cáo.

      Mọi giá trị đến từ khách hoặc client (cart attribute, query string, payload tracker) phải kiểm định dạng và độ dài trước khi ghi; giá trị không hợp lệ thành NULL, không được làm fail cả lô.

      Khi kết luận một field/API/tính năng "không có", dẫn nguồn đã kiểm (docs đúng version, introspection, response thật); không viết test hay doc khẳng định điều chưa kiểm.

      Khi port logic từ view/query có sẵn, liệt kê từng điều kiện lọc và join của bản gốc trong báo cáo, kèm dòng tương ứng ở bản port.

      Nếu spec hoặc câu trả lời của coordinator trái với quy tắc trong `docs/`/`AGENTS.md` của repo, báo lại một lần kèm file:dòng trước khi làm theo.

      Commit message phải có phần thân giải thích vì sao, kèm số liệu thật nếu quyết định dựa trên dữ liệu; tiêu đề trống ruột là chưa xong việc.

      Báo cáo phiên ghi vào `plans/reports/`, không vào `docs/`; runbook, smoke và test không gắn cứng mốc thời gian hay số liệu của ngày chạy — tính tại lúc chạy.

      Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

## Review gì

Reviewer độc lập (`SKILL.md` § 4); soát input, PII, DDL lock, backfill, LATERAL, pagination, watermark, mốc giờ.

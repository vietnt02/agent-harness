---
model: sol               # dòng model; slug = bản sol mới nhất trong catalog codex (Rule 18)
agent: codex             # truyền vào --agent
effort: high
ui: tệ                   # tốt | được | tệ | chưa rõ
backend: tốt             # tốt | được | tệ | chưa rõ
speed: vừa               # nhanh | vừa | chậm | chưa rõ
source: 1 phiên (tracking data pipeline, effort medium — 2 worker song song ở 2 repo, 5 commit, không lần nào respawn) + kinh nghiệm user (sol làm backend tương tự opus, cả họ GPT thua về UI/UX, context chỉ 272k, tốc độ vừa)
---

# gpt-sol

Nhận định ghi `(N phiên)`; phiên sau xác nhận thì tăng số, bác bỏ thì sửa hoặc xoá.
Frontmatter đổi theo.

## Khi nào dùng sol

Sol cùng tầm opus nên cost lớn. Sol **chỉ dùng khi user cho phép**, ghi tên trong manifest
kèm kế hoạch đã chốt (user chốt). Không bao giờ tự chọn, kể cả khi model khác hết quota; không vào lượt
chọn theo cột của `SKILL.md` § Chọn model theo loại việc.

## Spawn

Orca nhận thẳng `--agent codex --model <slug> --effort <mức>`. Khác luna 6, không cần
lấy model từ `~/.codex/config.toml`. Receipt ghi `launch.effective` =
`{codex, gpt-6.1-sol, medium}`, màn hình ghi `GPT-6.1-Sol medium · Approve for me`,
không có pha `default`. (1 phiên)

## Giao gì

- Backend, data pipeline, SQL, dbt cỡ vừa đến lớn, một lượt ra MR merge được. Ví dụ một worker
  làm 46 file, +2162 dòng gồm dlt ingest, 2 DAG, 11 mart dbt. Kết quả: pipeline xanh, smoke
  khớp nguồn, lượt chạy đầu trên Airflow prod ra đúng số smoke. (1 phiên)
- Đổi hướng giữa chừng không cần respawn: hợp đồng đổi 5 lần trong 13 phút qua
  `terminal send`, MR vẫn ra sau 31 phút và áp đủ. (1 phiên)
- Phản biện spec, cả 3 lần đều đúng, mỗi lần kèm default và options:
  - hợp đồng tự mâu thuẫn về `day_vn`;
  - dữ liệu một đơn mẫu khác spec;
  - tự thấy race `DROP CASCADE` của dbt-postgres mà spec không nhắc.

  Khác luna, vốn không phản biện spec. (1 phiên)
- Tự thấy rủi ro PII trong code có sẵn (`print(orders_data)` ghi cart attribute vào log)
  và escalate trước khi reviewer chạy. (1 phiên)
- Vòng sửa sau review nhanh và kỹ:
  - một worker sửa 24 finding trong 16 phút, build gold giảm từ 240 giây xuống 9,24 giây;
  - worker kia có test regression tái hiện lỗi trước khi sửa.

  (1 phiên)
- Kỷ luật ranh giới: không merge, không chạy DDL hay backfill ghi; tách test local với CI;
  báo cáo có Đã kiểm / CHƯA kiểm. (1 phiên)

## Không giao gì

- UI/UX. (kinh nghiệm user, cả họ GPT)
- Việc cần giữ nhiều context: context chỉ 272k (kinh nghiệm user). Một worker compaction một lần
  giữa vòng sửa, sau đó vẫn làm đủ. (1 phiên) Chia việc lớn thành nhiều worker thay vì một
  lượt dài.

## Phải nói rõ trong spec — câu chèn sẵn vào `--spec`

1. **Không tự kiểm hiệu năng theo cỡ dữ liệu.** Hai model gold dùng LATERAL quét lại bảng
   mỗi dòng: 61 giây ở 56,8k event, 240 giây ở 113,6k, ước vượt timeout 30 phút sau khoảng
   4 tháng. (1 phiên)

       Model SQL/dbt: chạy EXPLAIN và đo thời gian ở ít nhất 2× cỡ dữ liệu hiện tại; không dùng LATERAL/subquery tương quan quét lại bảng lớn cho mỗi dòng; ghi số đo vào báo cáo.

2. **Input từ phía khách không validate.** Cart attribute `_ms_cid` dài 300 ký tự sẽ gây
   `Data too long`, mà upsert chung một frame nên job orders dừng cho cả 7 store. (1 phiên)

       Mọi giá trị đến từ khách hoặc client (cart attribute, query string, payload tracker) phải kiểm định dạng và độ dài trước khi ghi; giá trị không hợp lệ thành NULL, không được làm fail cả lô.

3. **Kết luận "không có" mà không kiểm.** Nó ghi checkout không có `customAttributes` và
   viết cả test lẫn doc khẳng định điều đó, trong khi field có ở mọi bản API. (1 phiên)

       Khi kết luận một field/API/tính năng "không có", dẫn nguồn đã kiểm (docs đúng version, introspection, response thật); không viết test hay doc khẳng định điều chưa kiểm.

4. **Port logic không đối chiếu từng điều kiện của bản gốc.** Phiên tính trên mọi
   pageview, trong khi view gốc `reporting.session_source` lọc bot, theme preview và host
   ngoài danh sách. (1 phiên)

       Khi port logic từ view/query có sẵn, liệt kê từng điều kiện lọc và join của bản gốc trong báo cáo, kèm dòng tương ứng ở bản port.

5. **Làm theo câu trả lời của coordinator dù trái `docs/` của repo.** Coordinator trả lời
   "shared" pool, trái `docs/dbt-build.md`. Default ban đầu của worker mới đúng. Lỗi gốc ở
   coordinator, nhưng worker có đủ thông tin để báo. (1 phiên)

       Nếu spec hoặc câu trả lời của coordinator trái với quy tắc trong `docs/`/`AGENTS.md` của repo, báo lại một lần kèm file:dòng trước khi làm theo.

6. **Commit không có thân.** 5/5 commit chỉ có tiêu đề, commit đầu gom 1903 dòng.
   Giống luna. (1 phiên)

       Commit message phải có phần thân giải thích vì sao, kèm số liệu thật nếu quyết định dựa trên dữ liệu; tiêu đề trống ruột là chưa xong việc.

7. **Artifact phiên đặt sai chỗ, mốc gắn cứng.** Báo cáo phiên nằm trong `docs/`; runbook
   gắn cứng `--end` trước giờ deploy; smoke gắn cứng số đơn của ngày chạy. (1 phiên)

       Báo cáo phiên ghi vào `plans/reports/`, không vào `docs/`; runbook, smoke và test không gắn cứng mốc thời gian hay số liệu của ngày chạy — tính tại lúc chạy.

8. **Thiết kế do worker soạn, coordinator duyệt** (`../coordinator-rules.md` § Kiểm trước khi giao).

       Đọc code, gửi thiết kế (hàm, luồng, ca biên, test phải chứng minh gì) qua `ask`, chờ duyệt rồi mới sửa.

## Review gì sau `worker_done`

- Self-review bằng `spawn_agent` native của codex nông: chưa tới 3 phút, 1 finding.
  Reviewer do coordinator spawn chạy 22 phút, ra 3 chặn + 9 nên sửa + 12 nhỏ. Luôn spawn
  reviewer độc lập (`../coordinator-rules.md`). (1 phiên)
- Đọc diff và chạy lại test trên SHA cuối. Soát riêng: input từ khách, log in payload, DDL
  trên bảng đang có job chạy (lock, `ALGORITHM=INSTANT`), backfill ghi đè cột ngoài phạm
  vi, subquery tương quan/LATERAL, keyset pagination, watermark đọc lùi, mốc thời gian gắn
  cứng. (1 phiên)

## Cách nó giao tiếp, và kẹt ở đâu

- Ask đúng khuôn, có default và `options`; hỏi sớm, làm phần không phụ thuộc trong lúc chờ,
  không lần nào treo chờ trả lời. Status chủ động. (1 phiên)
- `worker-start` từ worker trả `consumer_fenced` (`../coordinator-rules.md`); worker không
  thử lại mà hỏi ngay. `spawn_agent` native của codex thì không bị chặn. (1 phiên)
- Không gửi status khi chuyển sang chờ CI: một vòng chờ 28 phút của coordinator hết hạn mà
  không có tin, phải đọc terminal mới biết. (1 phiên)
- Git không có sự cố: rebase không conflict, push đều được, worktree sạch khi bàn giao.
  (1 phiên)

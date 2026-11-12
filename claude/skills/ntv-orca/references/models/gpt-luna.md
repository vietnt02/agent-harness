---
model: luna
agent: codex
effort: max
ui: tệ
backend: được
speed: nhanh
source: 2 phiên (13 commit, 3 PR) + kinh nghiệm user
---

# gpt-luna

Chỉ dùng khi user chỉ định (`SKILL.md` § 2). Spawn: `--agent codex --model <slug> --effort max` (`~/.codex/models_cache.json`).

## Giao gì / Không giao gì

- **Giao:** Backend, pipeline, SQL, schema gọn một lượt (lọc báo cáo, sửa text, pagination, chống race); giữ kỷ luật tầng C. Task nhạy cảm (thư, hoá đơn, công nợ) cần duyệt kế hoạch và reviewer (`SKILL.md` § 1, § 4).
- **Không giao:** UI/UX; task dài (chia ≤ 30 phút, `SKILL.md` § 2); việc chưa kiểm dữ liệu thật (không tự phản biện spec).

## Phải nói rõ trong spec

      Commit message phải có phần thân giải thích vì sao, kèm số liệu thật nếu quyết định dựa trên dữ liệu; tiêu đề trống ruột là chưa xong việc.

      Trước khi sửa, nói xem bản vá này có tạo nguồn sự thật thứ hai hoặc nhân bản khai báo nào không; nếu có thì đề xuất chỗ gộp.

      Cuối báo cáo tách hai mục: "Đã kiểm: <cách> → <kết quả>" và "CHƯA kiểm: <điều gì> — <lý do>". Việc nào tự kiểm được trong scope thì kiểm xong mới báo; "CHƯA kiểm" chỉ dành cho việc scope cấm (dữ liệu prod, thao tác tầng B/C) hoặc cần người làm, không có thì ghi "CHƯA kiểm: không có".

      Trước mỗi commit, đọc tin mới nhất của coordinator. Bị chặn khi stage/commit/push thì giữ nguyên thay đổi, báo lệnh bị chặn qua ask — không revert, không rebase dở dang.

## Review gì

- Đối chiếu con số kế hoạch với output thô (`SKILL.md` § 1).
- Soát lỗi DRY, side effect mode chỉ-đọc, hai nhánh cùng đầu ra.
- DDL/SQL: dựng `probe_*` chạy thật, soát `CREATE TABLE IF NOT EXISTS` trên bảng đã có (`SKILL.md` § 4).
- Kiểm thân commit (không dính `\n` literal) và `git status` khi im lặng cuối lượt (`SKILL.md` § 6).

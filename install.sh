#!/usr/bin/env bash
set -euo pipefail

HOME_DIR="${HOME:-}"
DRY_RUN=0

usage() {
  echo "Cách dùng: $0 [--home <dir>] [--dry-run]"
  echo "  --home <dir>   Chỉ định thư mục home (mặc định: \$HOME)"
  echo "  --dry-run      Chỉ in các thao tác sẽ thực hiện, không thay đổi gì"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home)
      if [ $# -lt 2 ]; then
        echo "Lỗi: --home cần một tham số đường dẫn." >&2
        exit 1
      fi
      HOME_DIR="$2"
      shift 2
      ;;
    --home=*)
      HOME_DIR="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Lỗi: Tuỳ chọn không hợp lệ: $1" >&2
      usage
      ;;
  esac
done

if [ -z "$HOME_DIR" ]; then
  echo "Lỗi: Không xác định được thư mục HOME." >&2
  exit 1
fi

case "$HOME_DIR" in
  /*) ;;
  *) HOME_DIR="$(pwd)/$HOME_DIR" ;;
esac
HOME_DIR="${HOME_DIR%/}"

if ! command -v node >/dev/null 2>&1; then
  echo "Lỗi: Không tìm thấy lệnh 'node'. Vui lòng cài đặt Node.js trước khi chạy cài đặt." >&2
  exit 1
fi

NODE_CMD="$(command -v node)"
case "$NODE_CMD" in
  /*) NODE_BIN="$NODE_CMD" ;;
  *) NODE_BIN="$(cd "$(dirname "$NODE_CMD")" && pwd)/$(basename "$NODE_CMD")" ;;
esac

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$HOME_DIR/.claude/backups/harness-install-$TIMESTAMP"

backup_item() {
  local target="$1"
  local rel_target="${target#$HOME_DIR/}"
  local backup_target="$BACKUP_DIR/$rel_target"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Sao lưu: $target -> $backup_target"
    return 0
  fi

  mkdir -p "$(dirname "$backup_target")"
  mv "$target" "$backup_target"
  echo "Đã sao lưu: $target -> $backup_target"
}

install_file_symlink() {
  local src="$1"
  local target="$2"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$src" ]; then
    echo "Đã có: $target -> $src"
    return 0
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    backup_item "$target"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Tạo symlink: $target -> $src"
    return 0
  fi

  mkdir -p "$(dirname "$target")"
  ln -s "$src" "$target.harness-tmp"
  mv -f "$target.harness-tmp" "$target"
  echo "Đã tạo symlink: $target -> $src"
}

install_skill_symlink() {
  local src="$1"
  local target="$2"

  if [ -L "$target" ] && [ "$(readlink "$target")" = "$src" ]; then
    echo "Đã có: $target -> $src"
    return 0
  fi

  if [ -e "$target" ] || [ -L "$target" ]; then
    backup_item "$target"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Tạo symlink skill: $target -> $src"
    return 0
  fi

  mkdir -p "$(dirname "$target")"
  ln -s "$src" "$target"
  echo "Đã tạo symlink skill: $target -> $src"
}

# 1. Cài symlink claude files (trừ skills)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  rel_claude="${f#claude/}"
  src="$REPO_DIR/$f"
  target="$HOME_DIR/.claude/$rel_claude"
  install_file_symlink "$src" "$target"
done < <(find claude -type f ! -path 'claude/skills/*' ! -name '.DS_Store' | sort)

# 2. Cài symlink claude skills (nguyên thư mục)
for s in claude/skills/*; do
  [ -d "$s" ] || continue
  skill_name="$(basename "$s")"
  src="$REPO_DIR/claude/skills/$skill_name"
  target="$HOME_DIR/.claude/skills/$skill_name"
  install_skill_symlink "$src" "$target"
done

# 3. Cài symlink agy files
while IFS= read -r f; do
  [ -n "$f" ] || continue
  rel_agy="${f#agy/}"
  src="$REPO_DIR/$f"
  target="$HOME_DIR/.gemini/config/$rel_agy"
  install_file_symlink "$src" "$target"
done < <(find agy -type f ! -name '.DS_Store' | sort)

# 4. Copy templates/rules-mine/*.md
if [ -d "$REPO_DIR/templates/rules-mine" ]; then
  for t in "$REPO_DIR/templates/rules-mine"/*.md; do
    [ -f "$t" ] || continue
    fname="$(basename "$t")"
    target="$HOME_DIR/.claude/rules/mine/$fname"

    if [ -e "$target" ] || [ -L "$target" ]; then
      echo "Đã có template: $target (bỏ qua)"
    else
      if [ "$DRY_RUN" -eq 1 ]; then
        echo "[dry-run] Copy template: $t -> $target"
      else
        mkdir -p "$(dirname "$target")"
        cp "$t" "$target"
        echo "Đã copy template: $target"
      fi
    fi
  done
fi

# 5. Gộp hook bằng Node
if [ "$DRY_RUN" -eq 1 ]; then
  "$NODE_BIN" "$REPO_DIR/tools/merge-hooks.cjs" --home "$HOME_DIR" --node "$NODE_BIN" --backup-dir "$BACKUP_DIR" --dry-run
else
  "$NODE_BIN" "$REPO_DIR/tools/merge-hooks.cjs" --home "$HOME_DIR" --node "$NODE_BIN" --backup-dir "$BACKUP_DIR"
fi

# 6. Kiểm tra các guard phụ thuộc AgentKit
missing_guards=0
for f in "$HOME_DIR/.claude/hooks/lib/privacy-checker.cjs" \
         "$HOME_DIR/.claude/hooks/lib/scout-checker.cjs" \
         "$HOME_DIR/.claude/hooks/lib/secret-keywords.cjs"; do
  if [ ! -e "$f" ]; then
    missing_guards=1
    break
  fi
done

if [ "$missing_guards" -eq 1 ]; then
  echo "bridge agy sẽ chạy thiếu guard privacy/scout/secret: các file này thuộc AgentKit, không có trong repo"
fi

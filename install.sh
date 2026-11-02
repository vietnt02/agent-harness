#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Lỗi: Không tìm thấy lệnh 'node'. Vui lòng cài đặt Node.js trước khi chạy cài đặt." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/install.cjs" "$@"

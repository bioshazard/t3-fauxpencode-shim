#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
t3_home="${T3_HOME:-$repo_dir/artifacts/t3-shim-home}"

T3_HOME="$t3_home" bun "$repo_dir/tools/write-t3-shim-settings.ts"

if [[ -n "${T3_ROOT:-}" ]]; then
  if [[ ! -f "$T3_ROOT/package.json" ]]; then
    echo "T3_ROOT must point to a T3 checkout." >&2
    exit 1
  fi
  exec pnpm --dir "$T3_ROOT" run dev --home-dir "$t3_home"
fi

exec bunx "t3@${T3_VERSION:-0.0.37}" --base-dir "$t3_home"

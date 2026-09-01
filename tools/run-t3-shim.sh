#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
t3_root="${T3_ROOT:-/tmp/poc-opencode-pi-shim-t3code-pinned}"
t3_home="${T3_HOME:-$repo_dir/artifacts/t3-shim-home}"

if [[ ! -f "$t3_root/package.json" ]]; then
  echo "Set T3_ROOT to the T3 checkout." >&2
  exit 1
fi

T3_HOME="$t3_home" bun "$repo_dir/tools/write-t3-shim-settings.ts"
exec pnpm --dir "$t3_root" run dev --home-dir "$t3_home"

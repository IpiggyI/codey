#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$script_dir/.." && pwd)
(cd "$root" && node "$script_dir/build-overlay.mjs")
win_script=$(wslpath -w "$script_dir/build-windows.ps1")
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$win_script" "$@"

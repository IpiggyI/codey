#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$script_dir/.." && pwd)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    win_script=$(cygpath -w "$script_dir/build-windows.ps1")
    ;;
  Linux*)
    win_script=$(wslpath -w "$script_dir/build-windows.ps1")
    ;;
  *)
    echo "Windows packaging requires Git Bash or WSL." >&2
    exit 1
    ;;
esac
(cd "$root" && node "$script_dir/build-overlay.mjs")
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$win_script" "$@"

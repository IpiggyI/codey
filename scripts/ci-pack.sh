#!/usr/bin/env bash
# Build verification packages for the pushed HEAD of the current feature branch on
# GitHub Actions, then download them.
# Usage: scripts/ci-pack.sh [--new] [artifact-name ...]
#   --new          dispatch a fresh run even if this commit already has one
#   artifact-name  download only these artifacts (default: all of the run's artifacts)
set -euo pipefail

# Project settings: the packaging workflow file and the download folder prefix.
workflow=build-desktop.yml
download_prefix=codey-ci

force_new=0
names=()
for arg in "$@"; do
  case "$arg" in
    --new) force_new=1 ;;
    -*) echo "Usage: scripts/ci-pack.sh [--new] [artifact-name ...]" >&2; exit 2 ;;
    *) names+=("$arg") ;;
  esac
done

fail() { echo "CI_PACK_FAIL: $*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
repo=$(git remote get-url origin | sed -E 's#^(git@|ssh://git@|https://)github\.com[:/]##; s#\.git$##')

branch=$(git symbolic-ref --quiet --short HEAD) || fail "detached HEAD; switch to a feature branch."
default_branch=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name)
[[ "$branch" != "$default_branch" ]] || fail "on $default_branch; verification packages come from a feature branch."
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "uncommitted changes would not be in the package; commit and push first."

sha=$(git rev-parse HEAD)
remote_sha=$(git ls-remote origin "refs/heads/$branch" | cut -f1)
[[ "$remote_sha" == "$sha" ]] || fail "origin/$branch is ${remote_sha:-missing}, HEAD is $sha; push first."

latest_run() {
  gh run list -R "$repo" --workflow "$workflow" --event workflow_dispatch --commit "$sha" \
    --limit 1 --json databaseId,status,conclusion \
    --jq '.[0] | select(.) | "\(.databaseId) \(.status) \(.conclusion)"'
}

print_failure() {
  echo "CI_PACK_FAIL: run $run_id for $sha ended as $1." >&2
  gh run view "$run_id" -R "$repo" --log-failed | tail -n 200 >&2 || true
  exit 1
}

read -r run_id status conclusion <<<"$(latest_run)" || true
if [[ -n "${run_id:-}" && $force_new -eq 0 && "$status" == completed && "$conclusion" != success ]]; then
  echo "A failure from a flaky step can be retried with --new; otherwise fix and push a new commit." >&2
  print_failure "$conclusion"
fi

if [[ -z "${run_id:-}" || $force_new -eq 1 ]]; then
  previous=${run_id:-}
  gh workflow run "$workflow" -R "$repo" --ref "$branch"
  run_id=
  for _ in $(seq 1 30); do
    sleep 5
    read -r run_id status conclusion <<<"$(latest_run)" || true
    [[ -n "${run_id:-}" && "$run_id" != "$previous" ]] && break
    run_id=
  done
  [[ -n "$run_id" ]] || fail "dispatched, but no run for $sha appeared within 150s."
  echo "Dispatched run $run_id for $branch@${sha:0:8}"
else
  echo "Reusing run $run_id for $branch@${sha:0:8} ($status)"
fi
echo "https://github.com/$repo/actions/runs/$run_id"

last=
errors=0
while :; do
  if ! state=$(gh run view "$run_id" -R "$repo" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null); then
    errors=$((errors + 1))
    ((errors < 10)) || fail "could not read run $run_id status 10 times in a row."
    sleep 30
    continue
  fi
  errors=0
  read -r status conclusion <<<"$state"
  [[ "$status" != "$last" ]] && { echo "Run $run_id: $status"; last=$status; }
  [[ "$status" == completed ]] && break
  sleep 30
done
[[ "$conclusion" == success ]] || print_failure "$conclusion"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) downloads=$(cygpath -u "$USERPROFILE")/Downloads ;;
  Linux*)
    if win_profile=$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r') && [[ -n "$win_profile" ]]; then
      downloads=$(wslpath -u "$win_profile")/Downloads
    else
      downloads=$HOME/Downloads
    fi
    ;;
  *) downloads=$HOME/Downloads ;;
esac
dest="$downloads/$download_prefix-$run_id"

if [[ ${#names[@]} -eq 0 ]]; then
  while IFS= read -r name; do names+=("$name"); done \
    < <(gh api "repos/$repo/actions/runs/$run_id/artifacts" --jq '.artifacts[].name')
  [[ ${#names[@]} -gt 0 ]] || fail "run $run_id has no artifacts."
fi

# Each artifact lands in a .partial directory first, so an interrupted download is never reported as done.
for name in "${names[@]}"; do
  if [[ -d "$dest/$name" ]]; then
    echo "Already downloaded: $name"
    continue
  fi
  rm -rf "$dest/$name.partial"
  gh run download "$run_id" -R "$repo" -n "$name" -D "$dest/$name.partial" || fail "download of $name failed."
  mv "$dest/$name.partial" "$dest/$name"
done

for name in "${names[@]}"; do
  while IFS= read -r -d '' file; do
    if command -v wslpath >/dev/null 2>&1 && [[ "$file" == /mnt/* ]]; then
      echo "CI_PACK_OK: $(wslpath -w "$file")"
    else
      echo "CI_PACK_OK: $file"
    fi
  done < <(find "$dest/$name" -type f -print0 | sort -z)
done

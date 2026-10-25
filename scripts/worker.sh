#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
WORKTREE_ROOT="$(cd "$ROOT/.." && pwd)/pilab-worktrees"

usage() {
  cat <<'EOF'
Usage:
  scripts/worker.sh new <name>    Create ../pilab-worktrees/<name> on worker/<name>
  scripts/worker.sh merge <name>  Rebase, test, fast-forward into main, then remove worktree/branch
  scripts/worker.sh list          List registered worktrees
  scripts/worker.sh rm <name>     Remove a clean worktree and its safely-deletable branch
EOF
}

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$1" != "." && "$1" != ".." ]]
}

require_main_branch() {
  local branch
  branch="$(git -C "$ROOT" branch --show-current)"
  if [[ "$branch" != "main" ]]; then
    echo "worker.sh must be run from the main worktree (current branch: $branch)." >&2
    exit 1
  fi
}

require_main() {
  require_main_branch
  if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "Main worktree has uncommitted changes; commit or stash them before this operation." >&2
    exit 1
  fi
}

worker_path() { printf '%s/%s' "$WORKTREE_ROOT" "$1"; }
worker_branch() { printf 'worker/%s' "$1"; }

new_worker() {
  local name="$1" path branch
  valid_name "$name" || { echo "Invalid worker name: $name" >&2; exit 2; }
  require_main_branch
  path="$(worker_path "$name")"
  branch="$(worker_branch "$name")"
  [[ ! -e "$path" ]] || { echo "Worktree path already exists: $path" >&2; exit 1; }
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "Branch already exists: $branch" >&2; exit 1
  fi
  mkdir -p "$WORKTREE_ROOT"
  if ! git -C "$ROOT" worktree add -b "$branch" "$path" main; then
    echo "Could not create worker worktree." >&2; exit 1
  fi
  if [[ -d "$ROOT/node_modules" ]]; then
    ln -s "$ROOT/node_modules" "$path/node_modules"
  else
    echo "Main node_modules is missing; installing dependencies in worker (npm ci)." >&2
    (cd "$path" && npm ci)
  fi
  echo "Created $path on $branch (node_modules shared by symlink)."
}

remove_worker() {
  local name="$1" path branch
  valid_name "$name" || { echo "Invalid worker name: $name" >&2; exit 2; }
  path="$(worker_path "$name")"
  branch="$(worker_branch "$name")"
  if [[ ! -d "$path" ]]; then
    echo "Worktree not found: $path" >&2; exit 1
  fi
  # A shared node_modules symlink is local convenience state, not worker source.
  if [[ -L "$path/node_modules" ]]; then rm "$path/node_modules"; fi
  if ! git -C "$ROOT" worktree remove "$path"; then
    echo "Worktree removal stopped; it may contain uncommitted changes. Nothing was force-deleted." >&2
    exit 1
  fi
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    if ! git -C "$ROOT" branch -d "$branch"; then
      echo "Worktree removed, but $branch has unmerged commits and was preserved." >&2
      exit 1
    fi
  fi
  echo "Removed worktree $path and safely deletable branch $branch."
}

merge_worker() {
  local name="$1" path branch
  valid_name "$name" || { echo "Invalid worker name: $name" >&2; exit 2; }
  require_main
  path="$(worker_path "$name")"
  branch="$(worker_branch "$name")"
  [[ -d "$path" ]] || { echo "Worktree not found: $path" >&2; exit 1; }
  [[ "$(git -C "$path" branch --show-current)" == "$branch" ]] || {
    echo "Expected $branch checked out in $path." >&2; exit 1;
  }
  if [[ -n "$(git -C "$path" status --porcelain)" ]]; then
    echo "Worker worktree has uncommitted changes; commit them before merge." >&2; exit 1
  fi
  echo "Rebasing $branch onto main..."
  if ! git -C "$path" rebase main; then
    echo "Rebase conflict/failure; merge stopped. Resolve it in $path; nothing was merged." >&2
    exit 1
  fi
  echo "Running required worker checks..."
  if ! (cd "$path" && npm test && npx tsc --noEmit && npm run e2e); then
    echo "Checks failed; merge stopped and worktree preserved at $path." >&2
    exit 1
  fi
  if [[ -n "$(git -C "$path" status --porcelain)" ]]; then
    echo "Checks left tracked/untracked changes; inspect $path before merging." >&2; exit 1
  fi
  if ! git -C "$ROOT" merge --ff-only "$branch"; then
    echo "Fast-forward merge failed; main was not merged. Worktree preserved at $path." >&2
    exit 1
  fi
  git -C "$ROOT" worktree remove "$path"
  git -C "$ROOT" branch -d "$branch"
  echo "Merged $branch into main; removed its worktree and branch."
}

case "${1:-}" in
  new)
    [[ $# -eq 2 ]] || { usage >&2; exit 2; }
    new_worker "$2" ;;
  merge)
    [[ $# -eq 2 ]] || { usage >&2; exit 2; }
    merge_worker "$2" ;;
  list)
    [[ $# -eq 1 ]] || { usage >&2; exit 2; }
    git -C "$ROOT" worktree list ;;
  rm)
    [[ $# -eq 2 ]] || { usage >&2; exit 2; }
    remove_worker "$2" ;;
  *) usage >&2; exit 2 ;;
esac

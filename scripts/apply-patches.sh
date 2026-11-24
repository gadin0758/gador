#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-chromium-158-src> [--dry-run]" >&2
  exit 1
fi

CHROMIUM_SRC="$(realpath "$1")"
DRY_RUN="${2:-}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$DRY_RUN" != "--dry-run" ]; then
  ln -sfn "$REPO_ROOT/kernel" "$CHROMIUM_SRC/chrome/browser/agent_kernel"
  echo "[OK] Linked kernel/ -> $CHROMIUM_SRC/chrome/browser/agent_kernel"
fi

for p in "$REPO_ROOT"/patches/*.patch; do
  name="$(basename "$p")"
  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "[PATCH] $name (dry-run)"
    patch -p1 --dry-run -d "$CHROMIUM_SRC" < "$p"
  elif patch -p1 -R --dry-run --silent -d "$CHROMIUM_SRC" < "$p" >/dev/null 2>&1; then
    echo "[SKIP] $name (already applied)"
  else
    echo "[PATCH] $name"
    patch -p1 -N -d "$CHROMIUM_SRC" < "$p"
  fi
done
echo "[DONE] All Chromium 158 patches verified/applied cleanly."

#!/usr/bin/env bash
# Publish memlight to npm.
#
# Five-step sandbox contract (see PUBLISHING.md in the homura sandbox):
#   1. Preflight — clean tree, on main, authenticated to npm
#   2. Build     — tsc (run by npm's prepublishOnly)
#   3. Test      — vitest (run by npm's prepublishOnly)
#   4. Publish   — npm publish (public access)
#   5. Verify    — registry confirms the version
#
# npm 2FA NOTE: this npm account uses WEB-BASED 2FA, which a non-interactive
# shell cannot complete (it errors EOTP). For repeatable publishing put an npm
# AUTOMATION token in ~/.npmrc — it bypasses 2FA:
#   //registry.npmjs.org/:_authToken=npm_xxxxxxxx
# For an interactive one-off on a TOTP account you can pass --otp=CODE instead.
#
# Usage: npm run release        (or: ./publish.sh)
#        npm run release -- --dry-run
#        ./publish.sh --otp=123456
#        ./publish.sh --skip-preflight   # emergency only
#
# NB: the command is `npm run release`, NOT `npm run publish` — `publish` is a
# reserved npm lifecycle hook (npm auto-runs a script named `publish` AFTER
# `npm publish`), which would recurse into this script. Hence `release`.

set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO"

OTP_FLAG=""
DRY=""
SKIP_PREFLIGHT=0
for arg in "$@"; do
  case "$arg" in
    --otp=*) OTP_FLAG="--otp=${arg#--otp=}" ;;
    --dry-run) DRY="--dry-run" ;;
    --skip-preflight) SKIP_PREFLIGHT=1 ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Preflight ───────────────────────────────────────────────────────────────
if [ "$SKIP_PREFLIGHT" = 0 ]; then
  echo "=== Preflight ==="
  if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: working tree is dirty. Commit or stash first." >&2
    git status --short
    exit 1
  fi
  branch=$(git branch --show-current)
  if [ "$branch" != "main" ]; then
    echo "WARNING: on branch '$branch', not 'main'."
  fi
  if ! npm whoami >/dev/null 2>&1; then
    echo "ERROR: not authenticated to npm." >&2
    echo "  Run 'npm login', or put an automation token in ~/.npmrc." >&2
    exit 1
  fi
  echo "  tree clean, branch=$branch, npm user=$(npm whoami) ✓"
fi

# ── Build + Test + Publish ──────────────────────────────────────────────────
# prepublishOnly (in package.json) runs `tsc` + `vitest run` before upload.
echo "=== Publish ==="
npm publish $DRY $OTP_FLAG

# ── Verify ──────────────────────────────────────────────────────────────────
if [ -n "$DRY" ]; then
  echo "dry-run complete (nothing published)"
  exit 0
fi
version=$(node -p "require('./package.json').version")
echo ""
if npm view "memlight@$version" version >/dev/null 2>&1; then
  echo "Published — registry confirms memlight@$version ✓"
else
  echo "Published memlight@$version (registry not yet reflecting it; check shortly)"
fi
echo "Install with: npm install memlight"

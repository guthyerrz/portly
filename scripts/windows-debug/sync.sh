#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN="$SCRIPT_DIR/run.sh"

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "https://github.com/guthyerrz/portly.git")

echo "Syncing branch '$BRANCH' on Windows instance..."

"$RUN" "
cd C:\portly
git remote set-url origin '$REMOTE_URL'
git fetch origin
git checkout -B '$BRANCH' 'origin/$BRANCH'
git log -1 --oneline
"

echo ""
echo "Branch synced. Installing dependencies and rebuilding..."

"$RUN" "
cd C:\portly
pnpm install
pnpm build
Write-Host 'Build complete.'
"

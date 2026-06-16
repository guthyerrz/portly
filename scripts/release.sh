#!/usr/bin/env bash
#
# Cut a GitHub Release for the current packages/portly version, with the built
# tarball attached. Run after bumping the version in packages/portly/package.json.
#
#   pnpm release
#
# Requires: gh (authenticated), pnpm. Does not publish to npm — that happens via
# CI once the PUBLISH_NPM repo variable + npm trusted publishing are configured.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./packages/portly/package.json').version")
TAG="v$VERSION"

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Error: release $TAG already exists." >&2
  echo "Bump the version in packages/portly/package.json first." >&2
  exit 1
fi

echo "Building and packing portly@$VERSION..."
cd packages/portly
cp ../../README.md .
pnpm build
npm pack >/dev/null
# npm flattens the scope: @guthyerrz/portly -> guthyerrz-portly-<ver>.tgz
mv "guthyerrz-portly-$VERSION.tgz" "portly-$VERSION.tgz"

echo "Creating GitHub Release $TAG..."
gh release create "$TAG" --title "$TAG" --generate-notes "portly-$VERSION.tgz"

rm -f "portly-$VERSION.tgz" README.md
echo "Released $TAG -> https://github.com/guthyerrz/portly/releases/tag/$TAG"

#!/usr/bin/env bash
# Updates the Homebrew formula in charsdavy/homebrew-tap with freshly
# built binaries and their SHA256 digests. Idempotent — only commits when
# the formula actually changed.
#
# Required env vars:
#   TAP_TOKEN             — GitHub PAT with `repo` scope on the tap repo
#   VERSION               — version string (without leading 'v')
#   TAG                   — git tag (with leading 'v')
#   SHA_DARWIN_ARM64      — sha256 of deepseek-v<ver>-darwin-arm64.tar.gz
#   SHA_DARWIN_X64        — sha256 of deepseek-v<ver>-darwin-x64.tar.gz
#   SHA_LINUX_ARM64       — sha256 of deepseek-v<ver>-linux-arm64.tar.gz
#   SHA_LINUX_X64         — sha256 of deepseek-v<ver>-linux-x64.tar.gz
set -euo pipefail

TAP_REPO="charsdavy/homebrew-tap"
TAP_DIR="$(mktemp -d)/tap"
FORMULA_PATH="Formula/deepseek.rb"
RELEASE_REPO="${GITHUB_REPOSITORY:-charsdavy/deepseek-cli}"
RELEASE_URL="https://github.com/${RELEASE_REPO}/releases/download"

echo "==> Cloning $TAP_REPO"
git clone "https://x-access-token:${TAP_TOKEN}@github.com/${TAP_REPO}.git" "$TAP_DIR"
cd "$TAP_DIR"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

mkdir -p Formula

echo "==> Generating $FORMULA_PATH"
sed \
  -e "s|{{VERSION}}|${VERSION}|g" \
  -e "s|{{TAG}}|${TAG}|g" \
  -e "s|{{RELEASE_URL}}|${RELEASE_URL}|g" \
  -e "s|{{SHA_DARWIN_ARM64}}|${SHA_DARWIN_ARM64}|g" \
  -e "s|{{SHA_DARWIN_X64}}|${SHA_DARWIN_X64}|g" \
  -e "s|{{SHA_LINUX_ARM64}}|${SHA_LINUX_ARM64}|g" \
  -e "s|{{SHA_LINUX_X64}}|${SHA_LINUX_X64}|g" \
  "${GITHUB_WORKSPACE}/.github/scripts/formula.rb.tpl" > "$FORMULA_PATH"

echo "==> Verifying formula syntax"
if command -v brew >/dev/null 2>&1; then
  brew style "$FORMULA_PATH" || echo "::warning::brew style reported issues"
else
  echo "(brew not available on this runner; skipping local validation)"
fi

if git diff --quiet -- "$FORMULA_PATH"; then
  echo "==> Formula unchanged; nothing to commit"
  exit 0
fi

git add "$FORMULA_PATH"
git commit -m "deepseek ${VERSION}" -m "Auto-generated from ${RELEASE_REPO}@${TAG}"

git push origin HEAD
echo "==> Pushed formula update to $TAP_REPO"

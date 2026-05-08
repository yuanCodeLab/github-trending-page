#!/usr/bin/env bash
# Pushes the shadow branch using GITHUB_TOKEN when available,
# falling back to the configured git remote (works in GitHub Actions with GITHUB_TOKEN injected).
set -euo pipefail

BRANCH="${1:-claude/trending-shadow}"

if [ -n "${GITHUB_TOKEN:-}" ]; then
  REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/yuanCodeLab/github-trending-page.git"
  git push -u "${REMOTE}" "${BRANCH}"
else
  git push -u origin "${BRANCH}"
fi

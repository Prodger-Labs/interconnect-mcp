#!/usr/bin/env bash
# Installs git hooks from scripts/ into .git/hooks/.
# Run once after cloning or restoring the repo.
set -e
REPO_ROOT=$(git rev-parse --show-toplevel)
cp "$REPO_ROOT/scripts/pre-commit" "$REPO_ROOT/.git/hooks/pre-commit"
chmod +x "$REPO_ROOT/.git/hooks/pre-commit"
echo "Pre-commit hook installed."

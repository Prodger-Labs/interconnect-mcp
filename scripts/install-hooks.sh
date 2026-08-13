#!/usr/bin/env bash
# Installs git hooks from scripts/ into the repo's hooks directory.
# Run once after cloning or restoring the repo.
#
# The hooks directory is resolved with --git-path rather than assembled as
# .git/hooks. In a linked worktree .git is a file, not a directory, so the old
# path did not exist and cp died with "Not a directory". A failed install is the
# dangerous half: it leaves whatever stale hook was already in place still
# running, which is the exact state the pre-commit canary was written to catch.
set -e
cd "$(git rev-parse --show-toplevel)"
HOOKS=$(git rev-parse --git-path hooks)
mkdir -p "$HOOKS"
cp scripts/pre-commit "$HOOKS/pre-commit"
chmod +x "$HOOKS/pre-commit"
echo "Pre-commit hook installed to $HOOKS"

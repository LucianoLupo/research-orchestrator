#!/bin/bash
set -e

# research-orchestrator installer
# Symlinks the skill from this repo into ~/.claude/skills/

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SOURCE="$REPO_DIR/skills/research-orchestrator"
SKILL_TARGET="$HOME/.claude/skills/research-orchestrator"

echo "Installing research-orchestrator skill..."
echo "  Source: $SKILL_SOURCE"
echo "  Target: $SKILL_TARGET"

if [ ! -f "$SKILL_SOURCE/SKILL.md" ]; then
  echo "Error: SKILL.md not found at $SKILL_SOURCE"
  exit 1
fi

# Remove existing skill (file, symlink, or directory)
if [ -e "$SKILL_TARGET" ] || [ -L "$SKILL_TARGET" ]; then
  echo "  Replacing existing skill at $SKILL_TARGET"
  rm -rf "$SKILL_TARGET"
fi

mkdir -p "$HOME/.claude/skills"
ln -s "$SKILL_SOURCE" "$SKILL_TARGET"

echo ""
echo "Installed! The /research-orchestrator skill is now available in Claude Code."
echo "Restart Claude Code or start a new session to use it."

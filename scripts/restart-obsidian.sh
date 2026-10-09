#!/usr/bin/env bash
# Restart Obsidian with the DevTools protocol port open, so the automated acceptance
# suite (scripts/acceptance.mjs) can drive a real editor.
#
# Run this when the app has accumulated enough state (dirty buffers, plugin reloads,
# stray tabs) that test results stop being trustworthy. Starting from a clean process
# is much faster to reason about than unpicking interference between checks.
#
# usage: scripts/restart-obsidian.sh
set -euo pipefail

OBSIDIAN_EXE="${OBSIDIAN_EXE:-D:\\obsidian\\Obsidian.exe}"
PORT="${CDP_PORT:-9222}"

echo "closing Obsidian..."
MSYS_NO_PATHCONV=1 taskkill /IM Obsidian.exe >/dev/null 2>&1 || true
sleep 4

if tasklist 2>/dev/null | grep -qi obsidian; then
  echo "still running; forcing..."
  MSYS_NO_PATHCONV=1 taskkill /F /IM Obsidian.exe >/dev/null 2>&1 || true
  sleep 2
fi

echo "starting with --remote-debugging-port=${PORT}..."
MSYS_NO_PATHCONV=1 cmd /c start "" "$OBSIDIAN_EXE" --remote-debugging-port="$PORT"
sleep 10

if curl -s --max-time 5 "http://127.0.0.1:${PORT}/json/version" >/dev/null; then
  echo "ready: http://127.0.0.1:${PORT}"
else
  echo "ERROR: debug port did not come up" >&2
  exit 1
fi

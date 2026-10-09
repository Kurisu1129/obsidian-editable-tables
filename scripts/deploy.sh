#!/usr/bin/env bash
# Build + deploy the plugin into a vault's plugins directory.
# usage: scripts/deploy.sh [vault-path]   (defaults to ./spike-vault)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="${1:-$ROOT/spike-vault}"
PLUGIN_ID="editable-tables"
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

if [[ ! -d "$VAULT" ]]; then
  echo "vault not found: $VAULT" >&2
  exit 1
fi

mkdir -p "$DEST"
cp "$ROOT/main.js" "$ROOT/manifest.json" "$ROOT/styles.css" "$DEST/"
echo "deployed -> $DEST"
ls -la "$DEST"

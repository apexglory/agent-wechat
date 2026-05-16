#!/usr/bin/env bash
set -euo pipefail

# Build the openclaw-extension plugin and, if ~/.openclaw exists on this
# host, install the freshly-built dist/index.js into
# ~/.openclaw/extensions/wechat/dist/.
#
# The openclaw gateway is NOT restarted automatically — once this finishes,
# restart it (typically `systemctl --user restart openclaw-gateway.service`)
# so the new dist is loaded.
#
# Usage:
#   ./scripts/deploy-extension.sh

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
EXT_DIR="$ROOT_DIR/packages/openclaw-extension"
DIST_SRC="$EXT_DIR/dist/index.js"

if [ ! -d "$EXT_DIR" ]; then
  echo "==> openclaw-extension package not found at $EXT_DIR" >&2
  exit 1
fi

echo "==> Building openclaw-extension..."
pnpm -C "$EXT_DIR" build

if [ ! -f "$DIST_SRC" ]; then
  echo "==> Build did not produce $DIST_SRC" >&2
  exit 1
fi

DEST_DIR="$HOME/.openclaw/extensions/wechat/dist"
if [ -d "$HOME/.openclaw" ]; then
  mkdir -p "$DEST_DIR"
  cp "$DIST_SRC" "$DEST_DIR/index.js"
  bytes=$(wc -c < "$DIST_SRC" | tr -d ' ')
  echo "==> Installed ${bytes} bytes → $DEST_DIR/index.js"
  echo "==> Restart the gateway to load it:"
  echo "      systemctl --user restart openclaw-gateway.service"
else
  echo "==> No ~/.openclaw on this host — built only, nothing installed."
fi

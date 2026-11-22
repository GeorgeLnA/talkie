#!/bin/bash
# Installs (or updates) Talkie on a Mac. Usage:
#   curl -fsSL https://raw.githubusercontent.com/GeorgeLnA/talkie/main/install-mac.sh | bash
set -euo pipefail
case "$(uname -m)" in arm64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
URL="https://github.com/GeorgeLnA/talkie/releases/latest/download/Talkie-mac-$ARCH.zip"
DEST=/Applications
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Downloading Talkie for $ARCH Mac..."
curl -fL --progress-bar "$URL" -o "$TMP/Talkie.zip"
osascript -e 'tell application "Talkie" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST/Talkie.app"
ditto -x -k "$TMP/Talkie.zip" "$DEST"
# The app is not notarised by Apple, so remove the download flag that would block it.
xattr -dr com.apple.quarantine "$DEST/Talkie.app" 2>/dev/null || true
echo "Installed to $DEST/Talkie.app. Opening..."
open "$DEST/Talkie.app"

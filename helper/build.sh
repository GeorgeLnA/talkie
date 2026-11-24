#!/bin/bash
# Builds the Mac helper as one universal binary (Apple silicon and Intel) into build/helper/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build/helper
T=$(mktemp -d)
for arch in arm64 x86_64; do
  swiftc -O -target ${arch}-apple-macos13 helper/TalkieHelper.swift -o "$T/h-$arch" \
    -Xlinker -weak_framework -Xlinker FoundationModels 2>&1 | grep -v "warning:" || true
  test -f "$T/h-$arch"
done
lipo -create "$T/h-arm64" "$T/h-x86_64" -output build/helper/talkie-helper
codesign -s - -f build/helper/talkie-helper
rm -rf "$T"
file build/helper/talkie-helper

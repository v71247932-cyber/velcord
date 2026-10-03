#!/usr/bin/env bash
# Packs the desktop app files into public/desktop/velcord-app.tar.gz.
# The installer downloads this plus the official Electron release.
set -eu
cd "$(dirname "$0")"
OUT=../public/desktop
mkdir -p "$OUT"
tar -czf "$OUT/velcord-app.tar.gz" package.json main.js preload.js picker-preload.js picker.html offline.html icon.png
cp icon.icns "$OUT/icon.icns"
echo "built $OUT/velcord-app.tar.gz"

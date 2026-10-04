#!/usr/bin/env bash
# Builds the site and the server and puts them on this machine (/home/claude/velcord-vm), then restarts the service.
set -eu
cd "$(dirname "$0")/.."
DEST=/home/claude/velcord-vm
npm run build:frontend
npm run build:vm
mkdir -p "$DEST/dist"
rm -rf "$DEST/dist.new" && cp -r dist "$DEST/dist.new" && rm -f "$DEST/dist.new/_worker.js"
rm -rf "$DEST/dist.old" && { [ -d "$DEST/dist" ] && mv "$DEST/dist" "$DEST/dist.old" || true; } && mv "$DEST/dist.new" "$DEST/dist" && rm -rf "$DEST/dist.old"
cp vm/server.mjs vm/worker.mjs vm/schema.sql "$DEST/"
if systemctl is-active --quiet velcord; then sudo systemctl restart velcord; fi
echo "deployed to $DEST"

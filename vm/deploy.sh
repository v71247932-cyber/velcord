#!/usr/bin/env bash
# Builds the site and the server, puts them on this machine (/home/claude/velcord-vm) and restarts the service,
# then publishes the page files to the old Pages address (idk-site.pages.dev), where the installed desktop app still points.
set -eu
cd "$(dirname "$0")/.."
DEST=/home/claude/velcord-vm
npm run build:frontend
npm run build:vm
mkdir -p "$DEST/dist"
rm -rf "$DEST/dist.new" && cp -r dist "$DEST/dist.new" && rm -f "$DEST/dist.new/_worker.js" "$DEST/dist.new/_routes.json"
rm -rf "$DEST/dist.old" && { [ -d "$DEST/dist" ] && mv "$DEST/dist" "$DEST/dist.old" || true; } && mv "$DEST/dist.new" "$DEST/dist" && rm -rf "$DEST/dist.old"
cp vm/server.mjs vm/worker.mjs vm/schema.sql "$DEST/"
if systemctl is-active --quiet velcord; then sudo systemctl restart velcord; fi
echo "deployed to $DEST"
if [ -f "$DEST/pages.env" ]; then
  npm run build:worker
  set -a; . "$DEST/pages.env"; set +a
  npx wrangler pages deploy dist --project-name=idk-site --branch=main 2>&1 | tail -2
fi

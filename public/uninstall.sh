#!/usr/bin/env bash
# Removes the Velcord desktop app.   curl -s https://idk-site.pages.dev/uninstall.sh | bash
set -u
case "$(uname -s)" in
  Darwin)
    osascript -e 'tell application "Velcord" to quit' >/dev/null 2>&1 || true
    rm -rf "$HOME/Applications/Velcord.app" "$HOME/Library/Application Support/Velcord" \
           "$HOME/Library/Caches/com.velcord.desktop" "$HOME/Library/Preferences/com.velcord.desktop.plist"
    ;;
  Linux)
    D="$HOME/.local/share/velcord"
    pkill -f "$D/velcord" >/dev/null 2>&1 || true
    rm -rf "$D" "$HOME/.local/bin/velcord" "$HOME/.local/share/applications/velcord.desktop" "$HOME/.config/Velcord"
    ;;
esac
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/velcord"
echo "Velcord removed."

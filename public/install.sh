#!/usr/bin/env bash
# Velcord desktop installer for macOS and Linux.
#   curl -s https://idk-site.pages.dev/install.sh | bash
# Downloads the official Electron release (checked against a pinned SHA-256),
# adds the Velcord app files, installs for the current user (no sudo) and opens it.
set -eu
set -o pipefail 2>/dev/null || true

BASE="${VELCORD_BASE:-https://idk-site.pages.dev}"
ELECTRON_VERSION="44.5.1"

SHA_darwin_arm64="1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c"
SHA_darwin_x64="e567d13833d0e161d7749727355b98643461df3395b537cfa7bdddf8a8bfedff"
SHA_linux_x64="5bcd217611d6843ececd6c9e9c1fcd1da3ab066c43d8b1a9e4b44689a1fba6f5"
SHA_linux_arm64="ee1790d743af1abd6a7e3971589dcd8635b58dab51ca1359123ba5216ce3a453"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s ok%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s !!%s %s\n' "$Y" "$N" "$*" >&2; }
fail() { printf '%sxx%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed."; }

need curl
need tar

# ---- platform
OS="$(uname -s)"
MACHINE="$(uname -m)"
case "$OS" in
  Darwin)
    PLATFORM="darwin"
    if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi
    ;;
  Linux)
    PLATFORM="linux"
    case "$MACHINE" in
      x86_64|amd64) ARCH="x64" ;;
      aarch64|arm64) ARCH="arm64" ;;
      *) fail "Unsupported CPU: $MACHINE" ;;
    esac
    ;;
  *) fail "This installer supports macOS and Linux only." ;;
esac
KEY="${PLATFORM}_${ARCH}"
EXPECTED="$(eval "printf '%s' \"\${SHA_${KEY}}\"")"
ZIP="electron-v${ELECTRON_VERSION}-${PLATFORM}-${ARCH}.zip"
URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP}"

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else fail "Need shasum or sha256sum to verify the download."; fi
}

unzip_to() { # zip dest
  mkdir -p "$2"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$1" -d "$2"
  elif command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$1" "$2"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" "$2" <<'PY'
import os, stat, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        target = os.path.join(dest, info.filename)
        mode = info.external_attr >> 16
        if info.is_dir():
            os.makedirs(target, exist_ok=True)
        elif stat.S_ISLNK(mode):
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.lexists(target): os.remove(target)
            os.symlink(z.read(info).decode(), target)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, 'wb') as f: f.write(z.read(info))
            os.chmod(target, (mode & 0o777) or 0o644)
PY
  else
    fail "Need unzip, ditto or python3 to unpack the download."
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/velcord"
mkdir -p "$CACHE"

# ---- download Electron (cached, verified)
step "Downloading Electron ${ELECTRON_VERSION} for ${PLATFORM}/${ARCH}"
if [ -f "$CACHE/$ZIP" ] && [ "$(sha256_of "$CACHE/$ZIP")" = "$EXPECTED" ]; then
  ok "using cached download"
else
  curl -fL --retry 3 --progress-bar -o "$CACHE/$ZIP.part" "$URL" || fail "Download failed: $URL"
  mv "$CACHE/$ZIP.part" "$CACHE/$ZIP"
  [ "$(sha256_of "$CACHE/$ZIP")" = "$EXPECTED" ] || { rm -f "$CACHE/$ZIP"; fail "Checksum mismatch. The download was corrupted or tampered with, nothing was installed."; }
  ok "checksum verified"
fi

step "Downloading Velcord app files"
curl -fsSL --retry 3 -o "$TMP/app.tgz" "$BASE/desktop/velcord-app.tar.gz" || fail "Could not download $BASE/desktop/velcord-app.tar.gz"
mkdir -p "$TMP/appfiles"
tar -xzf "$TMP/app.tgz" -C "$TMP/appfiles"
printf '{"url":"%s/app"}\n' "$BASE" > "$TMP/appfiles/config.json"

step "Unpacking"
unzip_to "$CACHE/$ZIP" "$TMP/electron"

# ================================================================= macOS
if [ "$PLATFORM" = "darwin" ]; then
  APPS="$HOME/Applications"
  APP="$APPS/Velcord.app"
  mkdir -p "$APPS"

  step "Installing to $APP"
  if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
    osascript -e 'tell application "Velcord" to quit' >/dev/null 2>&1 || true
    sleep 2
  fi
  rm -rf "$APP"
  mv "$TMP/electron/Electron.app" "$APP"
  mkdir -p "$APP/Contents/Resources/app"
  cp -R "$TMP/appfiles/." "$APP/Contents/Resources/app/"
  curl -fsSL -o "$APP/Contents/Resources/electron.icns" "$BASE/desktop/icon.icns" || warn "Could not download the icon, keeping the default one."

  PB="/usr/libexec/PlistBuddy"
  PL="$APP/Contents/Info.plist"
  setp() { "$PB" -c "Set :$1 \"$2\"" "$PL" 2>/dev/null || "$PB" -c "Add :$1 string \"$2\"" "$PL"; }
  setp CFBundleName "Velcord"
  setp CFBundleDisplayName "Velcord"
  setp CFBundleIdentifier "com.velcord.desktop"
  setp NSMicrophoneUsageDescription "Velcord uses the microphone for voice calls."
  setp NSCameraUsageDescription "Velcord may use the camera for video calls."
  setp NSScreenCaptureUsageDescription "Velcord records your screen only when you share it in a call."

  # The bundle was edited, so give it a fresh local signature. macOS refuses to
  # grant microphone and screen permissions to a bundle with a broken signature.
  xattr -cr "$APP" 2>/dev/null || true
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || warn "Could not sign the app locally. Permissions may not work."
  fi
  ok "installed"

  step "Opening Velcord (macOS will now ask for notifications, microphone and screen recording)"
  open "$APP"
  printf '\n%sDone.%s Velcord is in %s\n' "$G" "$N" "$APP"
  printf 'If you decline a permission, enable it later in System Settings > Privacy & Security.\n'
  printf 'To remove it: curl -s %s/uninstall.sh | bash\n' "$BASE"
  exit 0
fi

# ================================================================= Linux
DIR="$HOME/.local/share/velcord"
BIN_DIR="$HOME/.local/bin"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$BIN_DIR" "$APPS_DIR"

step "Installing to $DIR"
pkill -f "$DIR/velcord" >/dev/null 2>&1 || true
rm -rf "$DIR"
mkdir -p "$DIR"
cp -R "$TMP/electron/." "$DIR/"
mv "$DIR/electron" "$DIR/velcord"
mkdir -p "$DIR/resources/app"
cp -R "$TMP/appfiles/." "$DIR/resources/app/"

# chrome-sandbox needs root to be setuid; a per-user install cannot do that, so run without it
cat > "$BIN_DIR/velcord" <<LAUNCH
#!/usr/bin/env bash
exec "$DIR/velcord" --no-sandbox "\$@"
LAUNCH
chmod +x "$BIN_DIR/velcord"

cat > "$APPS_DIR/velcord.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Velcord
Comment=Chat, calls and screen sharing
Exec=$BIN_DIR/velcord %U
Icon=$DIR/resources/app/icon.png
Terminal=false
Categories=Network;Chat;InstantMessaging;
StartupWMClass=Velcord
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
ok "installed"

case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "Add $BIN_DIR to your PATH to start it with the 'velcord' command." ;; esac

if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  step "Opening Velcord"
  nohup "$BIN_DIR/velcord" >/dev/null 2>&1 &
else
  warn "No desktop session detected. Start it later from the app menu or with: velcord"
fi
printf '\n%sDone.%s To remove it: curl -s %s/uninstall.sh | bash\n' "$G" "$N" "$BASE"

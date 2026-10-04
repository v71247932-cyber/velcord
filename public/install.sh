#!/usr/bin/env bash
# Velcord desktop installer for macOS and Linux.
#   curl -s https://velcord.scrisoricupovesti.ro/install.sh | bash
# Downloads the official Electron release (checked against a pinned SHA-256),
# adds the Velcord app files, installs for the current user (no sudo) and opens it.
set -eu
set -o pipefail 2>/dev/null || true

BASE="${VELCORD_BASE:-https://velcord.scrisoricupovesti.ro}"
# Newest Electron that still runs on each macOS (minimum system read from each release's Info.plist):
#   macOS 13 and newer -> 44.5.1     macOS 12 -> 43.7.7     macOS 11 -> 37.10.3     macOS 10.15 -> 32.3.3
# Linux always gets 44.5.1. Every download is checked against the official SHA-256 pinned here.
SHA_44_5_1_darwin_arm64="1d75703019bb16461ae65f3081d7e6f5c0b11e901d0ccb5c343bcf7bcdd6435c"
SHA_44_5_1_darwin_x64="e567d13833d0e161d7749727355b98643461df3395b537cfa7bdddf8a8bfedff"
SHA_44_5_1_linux_x64="5bcd217611d6843ececd6c9e9c1fcd1da3ab066c43d8b1a9e4b44689a1fba6f5"
SHA_44_5_1_linux_arm64="ee1790d743af1abd6a7e3971589dcd8635b58dab51ca1359123ba5216ce3a453"
SHA_43_7_7_darwin_arm64="9327d8ba5bc9e279d1a2f7da90235301c65a2e80eb4ad3bc5610d28d483340f9"
SHA_43_7_7_darwin_x64="cbed66567d55db4a2bffad0bb6ee9795ca0037ad241039f7473fe75680d10905"
SHA_37_10_3_darwin_arm64="24529be1f2f87c587d06c7474607f1b57d1184b3f45d916cac33791de3a70014"
SHA_37_10_3_darwin_x64="e545e2a41e5fd7d28bf1349b4f60f1bcfd8e4c216f57b2d3e698ec1c00b719cf"
SHA_32_3_3_darwin_x64="0499216feffc2ba56438d8c4ac89cf40117baee6335099f5b12457d339f465a6"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
ok()   { printf '%s ok%s %s\n' "$G" "$N" "$*"; }
warn() { printf '%s !!%s %s\n' "$Y" "$N" "$*" >&2; }
fail() { printf '%sxx%s %s\n' "$R" "$N" "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed."; }

need curl
need tar

# ---- platform
OS="${VELCORD_TEST_OS:-$(uname -s)}"
MACHINE="$(uname -m)"
ELECTRON_VERSION="44.5.1"
LEGACY_NOTE=""
case "$OS" in
  Darwin)
    PLATFORM="darwin"
    if [ -n "${VELCORD_TEST_ARM:-}" ]; then ARM="$VELCORD_TEST_ARM"; else ARM="$(sysctl -in hw.optional.arm64 2>/dev/null || echo 0)"; fi
    if [ "$ARM" = "1" ]; then ARCH="arm64"; else ARCH="x64"; fi

    MACOS="${VELCORD_TEST_MACOS:-$(sw_vers -productVersion 2>/dev/null || echo 0)}"
    MAJOR="${MACOS%%.*}"
    REST="${MACOS#*.}"; MINOR="${REST%%.*}"
    case "$MAJOR" in ''|*[!0-9]*) MAJOR=0 ;; esac
    case "$MINOR" in ''|*[!0-9]*) MINOR=0 ;; esac
    # macOS 11 can report itself as 10.16 to older programs
    if [ "$MAJOR" = "10" ] && [ "$MINOR" -ge 16 ]; then MAJOR=11; fi

    if [ "$MAJOR" -ge 13 ]; then
      ELECTRON_VERSION="44.5.1"
    elif [ "$MAJOR" = "12" ]; then
      ELECTRON_VERSION="43.7.7"; LEGACY_NOTE="macOS $MACOS is older than 13, so Velcord uses an Electron build that still supports it."
    elif [ "$MAJOR" = "11" ]; then
      ELECTRON_VERSION="37.10.3"; LEGACY_NOTE="macOS $MACOS is older than 12, so Velcord uses an Electron build that still supports it."
    elif [ "$MAJOR" = "10" ] && [ "$MINOR" -ge 15 ] && [ "$ARCH" = "x64" ]; then
      ELECTRON_VERSION="32.3.3"; LEGACY_NOTE="macOS $MACOS is old. Velcord uses the last Electron build that supports it. It no longer gets security updates, so updating macOS is recommended."
    else
      fail "Velcord needs macOS 10.15 or newer. This Mac has macOS $MACOS."
    fi
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
VKEY="$(printf '%s' "$ELECTRON_VERSION" | tr . _)"
KEY="${VKEY}_${PLATFORM}_${ARCH}"
EXPECTED="$(eval "printf '%s' \"\${SHA_${KEY}:-}\"")"
[ -n "$EXPECTED" ] || fail "No verified download for ${PLATFORM}/${ARCH} (Electron ${ELECTRON_VERSION})."
ZIP="electron-v${ELECTRON_VERSION}-${PLATFORM}-${ARCH}.zip"
URL="https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP}"

[ -n "$LEGACY_NOTE" ] && warn "$LEGACY_NOTE"
if [ -n "${VELCORD_DRY_RUN:-}" ]; then
  printf 'DRYRUN os=%s arch=%s electron=%s sha=%s\n' "$OS" "$ARCH" "$ELECTRON_VERSION" "$EXPECTED"
  exit 0
fi

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
  # An app that is still running would be re-opened instead of the new one, so make sure it is gone
  if pgrep -f "$APP/Contents/" >/dev/null 2>&1; then
    osascript -e 'tell application "Velcord" to quit' >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5 6; do pgrep -f "$APP/Contents/" >/dev/null 2>&1 || break; sleep 1; done
    pkill -f "$APP/Contents/" >/dev/null 2>&1 || true
    for _ in 1 2 3 4 5; do pgrep -f "$APP/Contents/" >/dev/null 2>&1 || break; sleep 1; done
    pkill -9 -f "$APP/Contents/" >/dev/null 2>&1 || true
  fi
  LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  [ -x "$LSREGISTER" ] || LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
  # Forget any earlier install first. macOS remembers the minimum macOS of the old copy
  # (for example from a newer Electron) and would refuse to open the new one.
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -u "$APP" >/dev/null 2>&1 || true
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
  touch "$APP"
  [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || true
  ok "installed"

  step "Opening Velcord (macOS will now ask for notifications, microphone and screen recording)"
  if ! open "$APP" 2>/dev/null; then
    warn "macOS would not open the app the normal way, starting it directly."
    nohup "$APP/Contents/MacOS/Electron" >/dev/null 2>&1 &
  fi
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

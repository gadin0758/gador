#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="${1:-$REPO_ROOT/dist/gador}"
RELEASE_DIR="${2:-$REPO_ROOT/dist/release}"
VERSION="${GADOR_VERSION:-v0.1.0}"
ARCH="$(uname -m)"
BUNDLE_NAME="gador-${VERSION}-linux-${ARCH}"
STAGE_DIR="$RELEASE_DIR/$BUNDLE_NAME"
ARCHIVE_PATH="$RELEASE_DIR/${BUNDLE_NAME}.tar.xz"

if [ ! -x "$DIST_DIR/lib/gador-engine/gador-bin" ]; then
  echo "[ERR] Missing packaged engine at $DIST_DIR/lib/gador-engine/gador-bin" >&2
  echo "      Run scripts/package-gador.sh first." >&2
  exit 1
fi

echo "[RELEASE] Staging clean Linux bundle (excluding modules/vpn and modules/privacy-shield) ..."
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"

# Copy runtime bundle and strictly remove concrete security/privacy modules
cp -a "$DIST_DIR/." "$STAGE_DIR/"
rm -rf "$STAGE_DIR/modules/vpn" "$STAGE_DIR/modules/privacy-shield"

# Bundle full user/API/module-developer documentation inside the Linux release archive
mkdir -p "$STAGE_DIR/docs"
cp -f "$REPO_ROOT/README.md" "$STAGE_DIR/README.md"
cp -f "$REPO_ROOT/AGENTS.md" "$STAGE_DIR/AGENTS.md"
cp -a "$REPO_ROOT/docs/." "$STAGE_DIR/docs/"

# Add standalone installer for extracted Linux release bundle
cat > "$STAGE_DIR/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BUNDLE_ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/gador"
BIN_DIR="$HOME/.local/bin"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

echo "[1/4] Installing Gador Linux bundle into $INSTALL_HOME ..."
mkdir -p "$INSTALL_HOME" "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$BUNDLE_ROOT/" "$INSTALL_HOME/"
else
  rm -rf "$INSTALL_HOME"/*
  cp -a "$BUNDLE_ROOT/." "$INSTALL_HOME/"
fi

echo "[2/4] Linking executables into $BIN_DIR ..."
ln -sfn "$INSTALL_HOME/bin/gador" "$BIN_DIR/gador"
ln -sfn "$INSTALL_HOME/bin/gador-ui" "$BIN_DIR/gador-ui"
ln -sfn "$INSTALL_HOME/bin/gador-mcp" "$BIN_DIR/gador-mcp"
ln -sfn "$INSTALL_HOME/bin/gador-ctl" "$BIN_DIR/gador-ctl"
ln -sfn "$INSTALL_HOME/bin/gador-mod" "$BIN_DIR/gador-mod"

echo "[3/4] Installing desktop entry and icon ..."
if [ -f "$INSTALL_HOME/assets/icon.svg" ]; then
  cp -f "$INSTALL_HOME/assets/icon.svg" "$ICON_DIR/gador.svg"
fi
cat > "$APP_DIR/gador.desktop" <<DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=Gador
GenericName=AI Agent Browser
Comment=AI-Agent native Gador browser with isolated AgentSpaces and Optical Lightfield UI
Exec=$BIN_DIR/gador --desktop %U
Icon=gador
StartupWMClass=gador
Terminal=false
Categories=Network;WebBrowser;Development;
StartupNotify=true
Actions=Daemon;Console;

[Desktop Action Daemon]
Name=Start Gador Windowless Daemon
Exec=$BIN_DIR/gador

[Desktop Action Console]
Name=Open Gador Control Console
Exec=$BIN_DIR/gador-ui
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true

echo "[4/4] Installing Agent Skills & initializing profile defaults ..."
if command -v node >/dev/null 2>&1; then
  node "$INSTALL_HOME/clients/plugin/install.mjs" --all >/dev/null || true
fi

echo "[OK] Gador installed to $INSTALL_HOME"
echo "  - Launch desktop: $BIN_DIR/gador --desktop"
echo "  - Launch daemon:  $BIN_DIR/gador"
echo "  - Docs included:  $INSTALL_HOME/README.md & $INSTALL_HOME/docs/"
echo "  - Custom modules: see $INSTALL_HOME/docs/module-developer-guide.md"
EOF
chmod +x "$STAGE_DIR/install.sh"

# Hard safety verification: abort if vpn or privacy-shield leaked into staging
if [ -e "$STAGE_DIR/modules/vpn" ] || [ -e "$STAGE_DIR/modules/privacy-shield" ]; then
  echo "[ERR] Forbidden module directory leaked into release staging!" >&2
  exit 1
fi

echo "[RELEASE] Compressing $ARCHIVE_PATH (multi-threaded xz) ..."
rm -f "$ARCHIVE_PATH" "$RELEASE_DIR/SHA256SUMS.txt"
XZ_OPT="-T0 -6" tar -C "$RELEASE_DIR" -cJf "$ARCHIVE_PATH" "$BUNDLE_NAME"
(cd "$RELEASE_DIR" && sha256sum "$(basename "$ARCHIVE_PATH")" > SHA256SUMS.txt)

echo "[OK] Linux release package ready:"
ls -lh "$ARCHIVE_PATH" "$RELEASE_DIR/SHA256SUMS.txt"
cat "$RELEASE_DIR/SHA256SUMS.txt"

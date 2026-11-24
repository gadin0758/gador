#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/gador"
BIN_DIR="$HOME/.local/bin"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

echo "[1/5] Incrementally packaging dist/gador ..."
bash "$REPO_ROOT/scripts/package-gador.sh"

echo "[2/5] Incrementally installing gador bundle into $INSTALL_HOME ..."
mkdir -p "$INSTALL_HOME" "$BIN_DIR" "$APP_DIR" "$ICON_DIR"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$REPO_ROOT/dist/gador/" "$INSTALL_HOME/"
else
  cp -au --remove-destination "$REPO_ROOT/dist/gador/." "$INSTALL_HOME/"
fi

echo "[3/5] Linking executables into $BIN_DIR ..."
ln -sfn "$INSTALL_HOME/bin/gador" "$BIN_DIR/gador"
ln -sfn "$INSTALL_HOME/bin/gador-ui" "$BIN_DIR/gador-ui"
ln -sfn "$INSTALL_HOME/bin/gador-mcp" "$BIN_DIR/gador-mcp"
ln -sfn "$INSTALL_HOME/bin/gador-ctl" "$BIN_DIR/gador-ctl"
ln -sfn "$INSTALL_HOME/bin/gador-mod" "$BIN_DIR/gador-mod"

echo "[4/5] Installing desktop entry and icon ..."
if [ -f "$REPO_ROOT/assets/icon.svg" ]; then
  cp -f "$REPO_ROOT/assets/icon.svg" "$ICON_DIR/gador.svg"
fi
cat > "$APP_DIR/gador.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Gador
GenericName=AI Agent Browser
Comment=AI-Agent native Gador browser with isolated AgentSpaces, independent VPN, and Optical Lightfield UI
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
EOF
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t "${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor" >/dev/null 2>&1 || true
fi

echo "[5/5] Syncing Agent Skills and MCP registrations to installed binary ..."
node "$REPO_ROOT/clients/plugin/install.mjs" --all >/dev/null
# Restart any running old gador-ui server so new API routes take effect immediately
pkill -f "^node $INSTALL_HOME/clients/ui/server.mjs" 2>/dev/null || true
node -e '
const fs = require("fs");
const path = require("path");
const mcpBin = path.join(process.env.HOME, ".local", "bin", "gador-mcp");

const claudePath = path.join(process.env.HOME, ".claude.json");
if (fs.existsSync(claudePath)) {
  const cfg = JSON.parse(fs.readFileSync(claudePath, "utf8"));
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.gador = { command: mcpBin, args: [] };
  fs.writeFileSync(claudePath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

const codexPath = path.join(process.env.HOME, ".codex", "config.toml");
if (fs.existsSync(codexPath)) {
  let toml = fs.readFileSync(codexPath, "utf8");
  const block = `[mcp_servers.gador]\ncommand = "${mcpBin}"\nargs = []\n`;
  if (toml.includes("[mcp_servers.gador]")) {
    toml = toml.replace(/\[mcp_servers\.gador\][\s\S]*?(?=\n\[|\s*$)/, block.trimEnd());
  } else {
    toml = toml.trimEnd() + "\n\n" + block;
  }
  fs.writeFileSync(codexPath, toml, { mode: 0o600 });
}
'

# Initialize Gador native profile defaults (Bookmark Bar visible, Forward button visible, native-ui.json ready)
node -e '
const fs = require("fs");
const path = require("path");
const cfgBase = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, ".config");
const gadorDir = path.join(cfgBase, "gador");
const defDir = path.join(gadorDir, "Default");
fs.mkdirSync(defDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(path.join(gadorDir, "vpn", "backups"), { recursive: true, mode: 0o700 });

const nativeUiPath = path.join(gadorDir, "native-ui.json");
if (!fs.existsSync(nativeUiPath)) {
  fs.writeFileSync(nativeUiPath, JSON.stringify({
    windowTitleSuffix: "Gador",
    consoleUrl: "http://127.0.0.1:43118",
    aiAuraEnabled: true,
    aiAuraColor: "#7d98ff",
    aiPausedColor: "#ffb547",
    aiAuraThickness: 3.0,
    aiAuraDepth: 20.0,
    aiAuraIntensity: 1.0,
    showLayoutToggle: true,
    showIncognitoButton: true,
    showSettingsButton: false,
    colorVariant: "neutral",
    tabActiveAccentBar: true,
    verticalTabCornerRadius: 10.0,
    tabAccentColor: "#7d98ff",
  }, null, 2) + "\n", { mode: 0o600 });
}

const prefsPath = path.join(defDir, "Preferences");
let prefs = {};
try {
  if (fs.existsSync(prefsPath)) prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
} catch { prefs = {}; }
prefs.bookmark_bar = { ...(prefs.bookmark_bar || {}), show_on_all_tabs: true };
prefs.browser = { ...(prefs.browser || {}), show_forward_button: true };
if (prefs.profile && prefs.profile.exit_type === "Crashed") {
  prefs.profile.exit_type = "Normal";
}
if (
  prefs.profile &&
  (prefs.profile.name === "您的 Chromium" ||
    prefs.profile.name === "Your Chromium" ||
    prefs.profile.name === "Chromium")
) {
  prefs.profile.name = "您的 Gador";
}
fs.writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 });

// Migrate stale cached "您的 Chromium" profile display name to "您的 Gador"
const localStatePath = path.join(gadorDir, "Local State");
if (fs.existsSync(localStatePath)) {
  try {
    const ls = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const cache = ls.profile && ls.profile.info_cache;
    let dirty = false;
    if (cache && typeof cache === "object") {
      for (const entry of Object.values(cache)) {
        if (
          entry &&
          (entry.name === "您的 Chromium" ||
            entry.name === "Your Chromium" ||
            entry.name === "Chromium")
        ) {
          entry.name = "您的 Gador";
          dirty = true;
        }
      }
    }
    if (dirty) {
      fs.writeFileSync(localStatePath, JSON.stringify(ls), { mode: 0o600 });
    }
  } catch {}
}
'

echo "[OK] gador installed cleanly on this machine!"
echo "  - Install dir:   $INSTALL_HOME"
echo "  - Commands:      gador | gador-ui | gador-mcp | gador-ctl | gador-mod"
echo "  - Desktop entry: $APP_DIR/gador.desktop"
echo "  - Custom modules & settings (unlocked only after verified modules are added):"
echo "      gador-mod list"
echo "      gador-mod settings list"

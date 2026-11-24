#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${1:-$REPO_ROOT/sources/chromium-158.0.8127.36/out/AgentDev}"
DIST_DIR="${2:-$REPO_ROOT/dist/gador}"

if [ ! -x "$OUT_DIR/chrome" ]; then
  echo "[ERR] Missing built Chromium binary at $OUT_DIR/chrome" >&2
  echo "      Build it first with: ninja -C \"$OUT_DIR\" chrome" >&2
  exit 1
fi

echo "[PACKAGE] Incrementally assembling gador distribution into $DIST_DIR ..."
mkdir -p "$DIST_DIR/bin" "$DIST_DIR/lib/gador-engine" "$DIST_DIR/clients/skills"

sync_path() {
  local src="${1%/}"
  local dst="${2%/}"
  mkdir -p "$dst"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$src/" "$dst/"
  else
    cp -au --remove-destination "$src/." "$dst/"
  fi
}

# 1. Incrementally sync Chromium runtime artifacts (binary, shared libs, pak/dat/icudtl/locales)
if command -v rsync >/dev/null 2>&1; then
  rsync -a "$OUT_DIR/chrome" "$DIST_DIR/lib/gador-engine/gador-bin"
else
  cp -au --remove-destination "$OUT_DIR/chrome" "$DIST_DIR/lib/gador-engine/gador-bin"
fi
for item in \
  *.so *.so.* *.pak *.bin *.dat *.json \
  chrome_crashpad_handler locales resources swiftshader MEIPreload; do
  shopt -s nullglob
  for f in "$OUT_DIR"/$item; do
    if [ -e "$f" ]; then
      if command -v rsync >/dev/null 2>&1; then
        rsync -a "$f" "$DIST_DIR/lib/gador-engine/"
      else
        cp -au --remove-destination "$f" "$DIST_DIR/lib/gador-engine/"
      fi
    fi
  done
  shopt -u nullglob
done

# 2. Incrementally sync MCP server, CLI, UI console shell, native AI lightfield extension, universal plugin SDK, protocol schema, site plugins, and gador Agent Skill
sync_path "$REPO_ROOT/clients/protocol/" "$DIST_DIR/clients/protocol/"
sync_path "$REPO_ROOT/clients/mcp-server/" "$DIST_DIR/clients/mcp-server/"
sync_path "$REPO_ROOT/clients/cli/" "$DIST_DIR/clients/cli/"
sync_path "$REPO_ROOT/clients/ui/" "$DIST_DIR/clients/ui/"
sync_path "$REPO_ROOT/clients/extension/" "$DIST_DIR/clients/extension/"
sync_path "$REPO_ROOT/clients/plugin/" "$DIST_DIR/clients/plugin/"
sync_path "$REPO_ROOT/clients/site-plugins/" "$DIST_DIR/clients/site-plugins/"
sync_path "$REPO_ROOT/clients/skills/gador/" "$DIST_DIR/clients/skills/gador/"
sync_path "$REPO_ROOT/modules/" "$DIST_DIR/modules/"
if [ -d "$REPO_ROOT/assets" ]; then
  mkdir -p "$DIST_DIR/assets"
  sync_path "$REPO_ROOT/assets/" "$DIST_DIR/assets/"
fi

# 3. Create top-level `gador` launcher (symlink-safe; isolated ~/.config/gador profile + CHROME_DESKTOP=gador.desktop so it NEVER activates system Chromium)
cat > "$DIST_DIR/bin/gador" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
export LD_LIBRARY_PATH="$ROOT/lib/gador-engine${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CHROME_DESKTOP="gador.desktop"
export CHROME_VERSION_EXTRA="Gador"

# Guard against Linux 108-byte AF_UNIX sun_path limit when spawned with a deep TMPDIR
if [ -n "${TMPDIR:-}" ] && [ "${#TMPDIR}" -gt 48 ]; then
  export TMPDIR="/tmp"
fi

GADOR_DATA_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/gador"
GADOR_SHELL_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/gador-shell"
mkdir -p "$GADOR_DATA_DIR" "$GADOR_SHELL_DIR"

has_user_data_dir() {
  for arg in "$@"; do
    case "$arg" in
      --user-data-dir|--user-data-dir=*) return 0 ;;
    esac
  done
  return 1
}

# Default to desktop windowless daemon mode unless --desktop or explicit engine flags are passed
if [ $# -eq 0 ]; then
  exec "$ROOT/lib/gador-engine/gador-bin" \
    --agent-daemon \
    --user-data-dir="$GADOR_DATA_DIR" \
    --class=gador
elif [ "${1:-}" = "--desktop" ]; then
  shift
  SOCK="${AGENT_KERNEL_SOCKET:-${XDG_RUNTIME_DIR:-/tmp}/gador/ctl.sock}"
  UI_PORT="${GADOR_UI_PORT:-43118}"
  UI_URL="http://127.0.0.1:${UI_PORT}"
  EXT_DIR="$ROOT/clients/extension"

  # 1) Ensure local Gador Optical Bridge & Console server is running on loopback (for AI lightfield overlay + Settings)
  if ! node -e "fetch('${UI_URL}/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    AGENT_KERNEL_SOCKET="$SOCK" GADOR_UI_PORT="$UI_PORT" node "$ROOT/clients/ui/server.mjs" >/dev/null 2>&1 &
    for _ in $(seq 1 40); do
      if node -e "fetch('${UI_URL}/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
  fi

  # 2) Launch REAL NATIVE Gador Browser directly in Gador's OWN ~/.config/gador profile (NEVER touches ~/.config/chromium!)
  #    - Single-layer native C++ Views UI: native AI concentric halo + Stop-AI + Zen Vertical/Chrome Top tabs + Incognito + R Settings
  #    - Opens cleanly onto Gador's New Tab Page (zero double-chrome, zero 127.0.0.1 in address bar)
  #    - Suppresses stale "Chromium 未正确关闭" crash-restore bubble on unclean restarts
  #    - Hosts AgentIpcServer on $SOCK in the same process for seamless AI MCP/Skill integration
  if ! pgrep -f "gador-bin.*--user-data-dir=${GADOR_DATA_DIR}" >/dev/null 2>&1; then
    GADOR_DATA_DIR="$GADOR_DATA_DIR" node -e '
      const fs = require("fs");
      const path = require("path");
      const p = path.join(process.env.GADOR_DATA_DIR, "Default", "Preferences");
      if (fs.existsSync(p)) {
        try {
          const j = JSON.parse(fs.readFileSync(p, "utf8"));
          let dirty = false;
          if (j.profile && j.profile.exit_type === "Crashed") {
            j.profile.exit_type = "Normal";
            dirty = true;
          }
          if (
            j.profile &&
            (j.profile.name === "您的 Chromium" ||
              j.profile.name === "Your Chromium" ||
              j.profile.name === "Chromium")
          ) {
            j.profile.name = "您的 Gador";
            dirty = true;
          }
          if (dirty) fs.writeFileSync(p, JSON.stringify(j), { mode: 0o600 });
        } catch {}
      }
      const lsPath = path.join(process.env.GADOR_DATA_DIR, "Local State");
      if (fs.existsSync(lsPath)) {
        try {
          const ls = JSON.parse(fs.readFileSync(lsPath, "utf8"));
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
          if (dirty) fs.writeFileSync(lsPath, JSON.stringify(ls), { mode: 0o600 });
        } catch {}
      }
    ' 2>/dev/null || true
  fi
  EXT_FLAGS=()
  EXT_LIST=""
  if [ -d "$EXT_DIR" ]; then
    EXT_LIST="$EXT_DIR"
  fi
  MOD_EXTS="$(node "$ROOT/modules/cli.mjs" extensions 2>/dev/null || true)"
  if [ -n "$MOD_EXTS" ]; then
    if [ -n "$EXT_LIST" ]; then
      EXT_LIST="${EXT_LIST},${MOD_EXTS}"
    else
      EXT_LIST="$MOD_EXTS"
    fi
  fi
  if [ -n "$EXT_LIST" ]; then
    EXT_FLAGS=(--load-extension="$EXT_LIST")
  fi
  exec "$ROOT/lib/gador-engine/gador-bin" \
    --user-data-dir="$GADOR_DATA_DIR" \
    --class=gador \
    "${EXT_FLAGS[@]}" \
    --hide-crash-restore-bubble \
    --no-first-run \
    --no-default-browser-check \
    "$@"
elif [ "${1:-}" = "--raw-desktop" ]; then
  shift
  if has_user_data_dir "$@"; then
    exec "$ROOT/lib/gador-engine/gador-bin" --class=gador "$@"
  else
    exec "$ROOT/lib/gador-engine/gador-bin" --user-data-dir="$GADOR_DATA_DIR" --class=gador "$@"
  fi
else
  if has_user_data_dir "$@"; then
    exec "$ROOT/lib/gador-engine/gador-bin" --class=gador "$@"
  else
    exec "$ROOT/lib/gador-engine/gador-bin" --user-data-dir="$GADOR_DATA_DIR" --class=gador "$@"
  fi
fi
EOF
chmod +x "$DIST_DIR/bin/gador"

# 4. Create symlink-safe `gador-mcp`, `gador-ctl`, and `gador-ui` launchers
cat > "$DIST_DIR/bin/gador-mcp" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
exec node "$ROOT/clients/mcp-server/index.mjs" "$@"
EOF
chmod +x "$DIST_DIR/bin/gador-mcp"

cat > "$DIST_DIR/bin/gador-ctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
exec node "$ROOT/clients/cli/gador-ctl.mjs" "$@"
EOF
chmod +x "$DIST_DIR/bin/gador-ctl"

cat > "$DIST_DIR/bin/gador-ui" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
exec node "$ROOT/clients/ui/server.mjs" "$@"
EOF
chmod +x "$DIST_DIR/bin/gador-ui"

cat > "$DIST_DIR/bin/gador-mod" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SELF="$(readlink -f "$0")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
exec node "$ROOT/modules/cli.mjs" "$@"
EOF
chmod +x "$DIST_DIR/bin/gador-mod"

echo "[OK] Packaged gador at: $DIST_DIR"
echo "  - Windowless daemon: $DIST_DIR/bin/gador            (default: --agent-daemon)"
echo "  - Desktop UI mode:   $DIST_DIR/bin/gador --desktop"
echo "  - Web Console Shell: $DIST_DIR/bin/gador-ui         (http://127.0.0.1:43118)"
echo "  - MCP Server:        $DIST_DIR/bin/gador-mcp"
echo "  - Shell CLI:         $DIST_DIR/bin/gador-ctl"
echo "  - Module Manager:    $DIST_DIR/bin/gador-mod        (install vpn / privacy-shield)"
echo "  - Agent Plugin:      $DIST_DIR/clients/plugin/plugin.json"
echo "  - Agent Skill:       $DIST_DIR/clients/skills/gador/SKILL.md"

#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <path-to-chromium-158-src> [out-dir-name]" >&2
  exit 1
fi

CHROMIUM_SRC="$(realpath "$1")"
OUT_NAME="${2:-AgentDev}"
OUT_DIR="$CHROMIUM_SRC/out/$OUT_NAME"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Link kernel/ and apply minimal Chromium 158 patches (idempotent)
"$REPO_ROOT/scripts/apply-patches.sh" "$CHROMIUM_SRC" || true

# 2. Ensure bundled node & cpython3 shims point to system binaries if absent in -lite tarball
NODE_BIN_DIR="$CHROMIUM_SRC/third_party/node/linux/node-linux-x64/bin"
if [ ! -x "$NODE_BIN_DIR/node" ]; then
  mkdir -p "$NODE_BIN_DIR"
  ln -sf "$(command -v node)" "$NODE_BIN_DIR/node"
fi
PY_BIN_DIR="$CHROMIUM_SRC/third_party/cpython3/host/bin"
if [ ! -x "$PY_BIN_DIR/python3" ]; then
  mkdir -p "$PY_BIN_DIR"
  ln -sf "$(command -v python3)" "$PY_BIN_DIR/python3"
fi

# 3. Generate fast developer component-build args.gn
# Prefer Chromium 158 matched toolchains in third_party/ (includes Crubit/Bindgen/Clang plugins),
# falling back to Arch system Clang/Rust only if absent.
mkdir -p "$OUT_DIR"
cat > "$OUT_DIR/args.gn" <<EOF
# gador fast incremental developer build
is_debug = false
is_component_build = true
is_official_build = false
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0

use_mold = false
use_lld = true
use_sysroot = false
use_system_libffi = true
treat_warnings_as_errors = false
fatal_linker_warnings = false

# Trim optional desktop bloat for faster compilation
use_qt5 = false
use_qt6 = false
use_pulseaudio = true
use_vaapi = true
enable_widevine = false
proprietary_codecs = true
ffmpeg_branding = "Chrome"
EOF

if [ ! -x "$CHROMIUM_SRC/third_party/llvm-build/Release+Asserts/bin/clang" ]; then
  CLANG_MAJOR="$(clang -dumpversion | cut -d. -f1)"
  cat >> "$OUT_DIR/args.gn" <<EOF
clang_base_path = "/usr"
clang_use_chrome_plugins = false
clang_version = "$CLANG_MAJOR"
EOF
fi

if [ ! -f "$CHROMIUM_SRC/third_party/rust-toolchain/VERSION" ]; then
  RUSTC_VER="$(rustc --version)"
  RUST_SYSROOT="$(rustc --print sysroot)"
  cat >> "$OUT_DIR/args.gn" <<EOF
rust_sysroot_absolute = "$RUST_SYSROOT"
rust_bindgen_root = "/usr"
rustc_version = "$RUSTC_VER"
EOF
fi

GN_BIN="$CHROMIUM_SRC/buildtools/linux64/gn"
if [ ! -x "$GN_BIN" ]; then
  GN_BIN="$(command -v gn)"
fi

echo "[GN] Generating Ninja files in $OUT_DIR using $GN_BIN ..."
cd "$CHROMIUM_SRC"
"$GN_BIN" gen "$OUT_DIR" --script-executable="$(command -v python3)"

echo "[NINJA] Ready! To build Chrome:"
echo "  ninja -C \"$OUT_DIR\" chrome"

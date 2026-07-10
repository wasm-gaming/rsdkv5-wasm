#!/usr/bin/env bash
set -euo pipefail

# Builds a GAME-AGNOSTIC RSDKv5U (Retro Engine v5 Ultimate) WASM. This script does
# NOT invoke Docker itself — it runs the build steps directly and expects an
# Emscripten SDK environment on PATH (emcc, emcmake, cmake, make, git, python3).
# Run it either:
#   - in CI, inside an `emscripten/emsdk` container job (see .github/workflows), or
#   - locally, via scripts/build-docker.sh (which runs this inside the container).
#
# Unlike the original per-platform build, Data.rsdk / settings.ini are NOT baked in
# with --preload-file. The engine is built with -sINVOKE_RUN=0 and the FS/callMain
# runtime methods exported, so the JS SDK (src/rsdkv5.sdk.ts) writes the game data
# into the filesystem at runtime and then calls main().
#
# IMPORTANT — how v5 differs from v3/v4 (see also the header of the CI workflow):
#
#   * BUILD SYSTEM. v5 is a CMake project (RetroEngine target), not a hand-written
#     Makefile. There is no `wasm` make target to sed-patch as in rsdkv4-wasm; we
#     drive `emcmake cmake` + `cmake --build` and inject the SDK-contract flags by
#     appending to platforms/Emscripten.cmake (the CMake analog of v4's sed patch).
#
#   * MAIN MODULE + SIDE MODULE. The stock web fork links with -sMAIN_MODULE=1: the
#     engine is game-agnostic and the actual game logic (Sonic Mania) is a separate
#     `Game.wasm` SIDE_MODULE, loaded at runtime. Building that side module needs
#     the Sonic Mania decompilation (its own `web` branch) and is gated behind
#     RSDKV5_GAME_REPO below; without it the engine boots but has no game to run.
#
#   * PTHREADS => CROSS-ORIGIN ISOLATION IS MANDATORY. The stock flags use
#     -sUSE_PTHREADS=1, which requires SharedArrayBuffer, which requires COOP/COEP
#     on every response. `make preview` (scripts/preview-server.py) sends those
#     headers; plain GitHub Pages CANNOT, so the Pages demo will not run the engine.
#     Set RSDKV5_SINGLE_THREAD=1 to drop pthreads for a Pages-hostable (but slower /
#     unverified) build.
#
#   * PERSISTENCE is IDBFS (-lidbfs.js) in v5, not OPFS/WASMFS as in rsdkv4-wasm.
#
# Output (to match package.json / the manifest):
#   dist/rsdkv5/rsdkv5.js    (ES6 factory, EXPORT_NAME=createRSDKv5)
#   dist/rsdkv5/rsdkv5.wasm
#   dist/rsdkv5/Game.wasm    (only when RSDKV5_GAME_REPO is set)
# In CI these are attached to a GitHub Release.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$ROOT_DIR/.tmp/rsdkv5-wasm-build"
DIST_DIR="$ROOT_DIR/dist"

# Engine source. Defaults to the RSDK-Library web fork (the one wired for Emscripten
# via platforms/Emscripten.cmake). Override REPO/REF to pin or swap the source.
RSDKV5_DECOMP_REPO="${RSDKV5_DECOMP_REPO:-https://github.com/Jdsle/RSDKv5-Decompilation.git}"
RSDKV5_DECOMP_REF="${RSDKV5_DECOMP_REF:-web}"

# Game (side module) source — OPTIONAL. Without it, the engine builds but there is
# no Game.wasm to load, so it cannot run a game. A complete WASM Sonic Mania game
# module is not a finished public artifact; leave unset until one is available.
RSDKV5_GAME_REPO="${RSDKV5_GAME_REPO:-}"
RSDKV5_GAME_REF="${RSDKV5_GAME_REF:-web}"

# RETRO_REVISION=3 selects RSDKv5U (see the fork's CMakeLists.txt).
RETRO_REVISION="${RETRO_REVISION:-3}"

# Set to 1 to drop pthreads (Pages-hostable, no COOP/COEP required, but unverified).
RSDKV5_SINGLE_THREAD="${RSDKV5_SINGLE_THREAD:-0}"

echo "Setting up workspace..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$DIST_DIR/rsdkv5"

echo "Cloning RSDKv5 decompilation ($RSDKV5_DECOMP_REPO @ $RSDKV5_DECOMP_REF)..."
git clone --depth=1 --branch "$RSDKV5_DECOMP_REF" "$RSDKV5_DECOMP_REPO" "$WORK_DIR"

echo "Injecting SDK-contract Emscripten flags into platforms/Emscripten.cmake..."
# The stock web fork emits a plain RSDKv5U.js driven by the RSDK-Library engine
# manager. This repo's SDK (src/rsdkv5.sdk.ts) instead does:
#     import createRSDKv5 from './rsdkv5.js'
#     Module.FS.writeFile(...); Module.callMain(['UsingCWD'])
# so we append the modularize/export/no-auto-run flags to the engine's link
# options. Emscripten honours the LAST value for duplicate -s flags, and the stock
# file sets none of these, so appending is a clean override (the CMake analog of
# rsdkv4-wasm's Makefile sed-patch). NOTE: EXPORT_ES6 + pthreads + MAIN_MODULE is a
# known-fragile Emscripten combination — the first real container build is expected
# to shake out flag interactions here; adjust this block accordingly.
python3 - "$WORK_DIR/platforms/Emscripten.cmake" "$RSDKV5_SINGLE_THREAD" <<'PYEOF'
import sys
path, single_thread = sys.argv[1], sys.argv[2] not in ("", "0")

with open(path, "r", encoding="utf-8") as f:
    content = f.read()

anchor = "    -Wl,--no-whole-archive\n)"
assert content.count(anchor) == 1, "could not find emsc_link_options close anchor"

extra = [
    "    # --- injected by rsdkv5-wasm/scripts/build.sh (SDK contract) ---",
    "    -sMODULARIZE=1",
    "    -sEXPORT_ES6=1",
    "    -sEXPORT_NAME=createRSDKv5",
    "    -sINVOKE_RUN=0",
    "    \"-sEXPORTED_RUNTIME_METHODS=['callMain','FS','ccall','cwrap']\"",
    "    \"-sEXPORTED_FUNCTIONS=['_main']\"",
]
if single_thread:
    # Drop threads for a Pages-hostable build (no SharedArrayBuffer / COOP-COEP).
    # This diverges from the stock flags and is UNVERIFIED — SDL2 + the engine's
    # audio/main-loop may assume the pooled worker threads.
    extra += [
        "    -sUSE_PTHREADS=0",
        "    -sPTHREAD_POOL_SIZE=0",
    ]

content = content.replace(anchor, "\n".join(extra) + "\n" + anchor, 1)
with open(path, "w", encoding="utf-8") as f:
    f.write(content)
print("  patched", path)
PYEOF

echo "Configuring engine (emcmake cmake, PLATFORM=Emscripten, RETRO_REVISION=$RETRO_REVISION)..."
( cd "$WORK_DIR" && emcmake cmake -B build \
    -DPLATFORM=Emscripten \
    -DRETRO_REVISION="$RETRO_REVISION" \
    -DRETRO_OUTPUT_NAME=rsdkv5 \
    -DCMAKE_BUILD_TYPE=Release )

echo "Building engine (cmake --build)..."
( cd "$WORK_DIR" && cmake --build build --config Release -j"$(nproc 2>/dev/null || echo 4)" )

echo "Locating engine artifacts..."
# CMake places the executable (SUFFIX .js) and its sidecar .wasm under build/.
ENGINE_JS="$(find "$WORK_DIR/build" -name 'rsdkv5.js' -print -quit)"
ENGINE_WASM="$(find "$WORK_DIR/build" -name 'rsdkv5.wasm' -print -quit)"
if [[ -z "$ENGINE_JS" || -z "$ENGINE_WASM" ]]; then
  echo "build.sh: could not find rsdkv5.js / rsdkv5.wasm under $WORK_DIR/build" >&2
  echo "  Build tree contents:" >&2
  find "$WORK_DIR/build" -maxdepth 2 -name '*.js' -o -name '*.wasm' >&2 || true
  exit 1
fi
cp "$ENGINE_JS" "$DIST_DIR/rsdkv5/rsdkv5.js"
cp "$ENGINE_WASM" "$DIST_DIR/rsdkv5/rsdkv5.wasm"

# --- Optional: Sonic Mania game side module (Game.wasm) --------------------------
if [[ -n "$RSDKV5_GAME_REPO" ]]; then
  GAME_DIR="$ROOT_DIR/.tmp/rsdkv5-game-build"
  echo "Cloning game source ($RSDKV5_GAME_REPO @ $RSDKV5_GAME_REF)..."
  rm -rf "$GAME_DIR"
  git clone --depth=1 --branch "$RSDKV5_GAME_REF" "$RSDKV5_GAME_REPO" "$GAME_DIR"

  echo "Building game side module (emcmake cmake, SIDE_MODULE)..."
  ( cd "$GAME_DIR" && emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release \
      && cmake --build build --config Release -j"$(nproc 2>/dev/null || echo 4)" )

  GAME_WASM="$(find "$GAME_DIR/build" -name 'Game.wasm' -print -quit)"
  if [[ -z "$GAME_WASM" ]]; then
    echo "build.sh: game build produced no Game.wasm under $GAME_DIR/build" >&2
    exit 1
  fi
  cp "$GAME_WASM" "$DIST_DIR/rsdkv5/Game.wasm"
else
  echo "RSDKV5_GAME_REPO not set — skipping Game.wasm (engine will boot without a game)." >&2
fi

echo "Build complete. Artifacts:"
ls -la "$DIST_DIR/rsdkv5"

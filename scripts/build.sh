#!/usr/bin/env bash
set -euo pipefail

# Builds the RSDKv5U (Retro Engine v5 Ultimate) WASM. This script does NOT invoke
# Docker itself — it expects an Emscripten SDK environment on PATH (emcc, emcmake,
# cmake, make, git, python3). Run it either:
#   - in CI, inside an `emscripten/emsdk` container job (see .github/workflows), or
#   - locally, via scripts/build-docker.sh (which runs this inside the container).
#
# NOT WIRED UP YET — intentionally exits non-zero. Unlike v3/v4 (which adapted an
# existing community Emscripten fork), RSDKv5-Decompilation has no upstream
# Emscripten platform, and the only proven build compiles Sonic Mania *statically*
# into the engine (CMake, -DGAME_STATIC=ON). Two concrete approaches are fully
# specified in docs/wasm-build-approaches.md; each is meant to be implemented on
# its own branch. A working reference recipe lives at
# .peers/build-rsdkv5-docker.sh (play.germade).

echo "build.sh: RSDKv5 WASM build is not wired up on this branch." >&2
echo "  See docs/wasm-build-approaches.md for the two implementation approaches" >&2
echo "  (A: static+preload, mirrors .peers/build-rsdkv5-docker.sh; B: keep the" >&2
echo "  createRSDKv5 factory + runtime data mount). Implement one per branch." >&2
exit 1

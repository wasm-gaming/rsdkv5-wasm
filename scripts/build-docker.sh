#!/usr/bin/env bash
set -euo pipefail

# Local convenience wrapper: runs scripts/build.sh inside the emscripten/emsdk
# container, so you don't need a local Emscripten toolchain.
#
# In CI, build.sh runs directly inside an emscripten/emsdk *container job*
# (see .github/workflows/build.yml) and this wrapper is not used.
#
# Pinned to the exact toolchain the proven recipe was verified with
# (Emscripten 6.0.2; see docs/wasm-build-shared-core.md). Override with
# EMSDK_IMAGE=... if needed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:6.0.2}"

exec docker run --rm \
  -v "$ROOT_DIR:/src" \
  -w /src \
  "$IMAGE" \
  bash scripts/build.sh "$@"

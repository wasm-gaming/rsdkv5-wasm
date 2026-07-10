#!/usr/bin/env bash
set -euo pipefail

# Local convenience wrapper: runs scripts/build.sh inside the emscripten/emsdk
# container, so you don't need a local Emscripten toolchain.
#
# In CI, build.sh runs directly inside an emscripten/emsdk *container job*
# (see .github/workflows/build.yml) and this wrapper is not used.
#
# Override the image with EMSDK_IMAGE=... if needed.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${EMSDK_IMAGE:-emscripten/emsdk:latest}"

exec docker run --rm \
  -v "$ROOT_DIR:/src" \
  -w /src \
  "$IMAGE" \
  bash scripts/build.sh "$@"

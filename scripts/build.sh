#!/usr/bin/env bash
set -euo pipefail

# Builds Sonic Mania (RSDKv5U decompilation) as WASM — APPROACH A: static+preload.
# See docs/wasm-build-approach-a-static-preload.md; this is a faithful port of the
# proven recipe (.peers/build-rsdkv5-docker.sh, play.germade, verified 2026-07-05
# through Studiopolis gameplay) with only paths/output names adapted.
#
# This script does NOT invoke Docker itself — it expects an Emscripten SDK
# environment on PATH (emcc, emcmake, cmake, make, git, python3). Run it either:
#   - in CI, inside an `emscripten/emsdk` container job (see .github/workflows), or
#   - locally, via scripts/build-docker.sh (which runs this inside the container).
#
# Model (differs from rsdkv3/rsdkv4): the game is compiled STATICALLY into the
# engine (-DGAME_STATIC=ON) and Data.rsdk/Settings.ini are BAKED IN with
# --preload-file (→ rsdkv5.data). The module is a plain (non-MODULARIZE) build
# that auto-runs main(); the SDK's job is just to stand up `Module` and inject
# the script. Single-threaded → no COOP/COEP needed → GitHub-Pages hostable.
#
# Output (matching package.json / the manifest):
#   dist/rsdkv5/rsdkv5.js
#   dist/rsdkv5/rsdkv5.wasm
#   dist/rsdkv5/rsdkv5.data   (preloaded Data.rsdk + Settings.ini)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$ROOT_DIR/.tmp/rsdkv5-wasm-build"
DIST_DIR="$ROOT_DIR/dist"

# Game data to bake in. Never committed (*.rsdk is git-ignored); `make clean`
# deliberately preserves dist/Data.rsdk, making it the natural local drop spot.
RSDKV5_DATA_RSDK="${RSDKV5_DATA_RSDK:-$DIST_DIR/Data.rsdk}"

# Pinned for reproducibility (same pins as the proven recipe).
SONIC_MANIA_COMMIT="9dc699428420d752af9767bdb13f585ee0881bc0"
OGG_COMMIT="06a5e0262cdc28aa4ae6797627a783b5010440f0"
THEORA_COMMIT="28fd5ec77f0ad0e07a371cef1047828116f6bd8a"

if [ ! -f "$RSDKV5_DATA_RSDK" ]; then
    echo "build.sh: Data.rsdk not found at $RSDKV5_DATA_RSDK" >&2
    echo "  Approach A bakes the game data into rsdkv5.data at build time." >&2
    echo "  Drop your legally-extracted Sonic Mania Data.rsdk at dist/Data.rsdk" >&2
    echo "  or point RSDKV5_DATA_RSDK=... at it." >&2
    exit 1
fi

echo "Setting up workspace..."
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$DIST_DIR/rsdkv5"

echo "Cloning Sonic-Mania-Decompilation (pinned @ $SONIC_MANIA_COMMIT)..."
git clone https://github.com/RSDKModding/Sonic-Mania-Decompilation.git "$WORK_DIR"
git -C "$WORK_DIR" checkout --quiet "$SONIC_MANIA_COMMIT"
git -C "$WORK_DIR" submodule update --init --recursive

RSDK_DIR="$WORK_DIR/dependencies/RSDKv5"

echo "Vendoring libogg (pinned @ $OGG_COMMIT) — no system package under Emscripten..."
OGG_TMP="$(mktemp -d)"
git clone --quiet https://github.com/xiph/ogg.git "$OGG_TMP"
git -C "$OGG_TMP" checkout --quiet "$OGG_COMMIT"
mkdir -p "$RSDK_DIR/dependencies/emscripten/libogg/src" "$RSDK_DIR/dependencies/emscripten/libogg/include/ogg"
cp "$OGG_TMP/src/bitwise.c" "$OGG_TMP/src/framing.c" "$OGG_TMP/src/crctable.h" "$RSDK_DIR/dependencies/emscripten/libogg/src/"
cp "$OGG_TMP/include/ogg/ogg.h" "$OGG_TMP/include/ogg/os_types.h" "$RSDK_DIR/dependencies/emscripten/libogg/include/ogg/"
# config_types.h is normally autotools/cmake-generated from config_types.h.in;
# reuse the copy already vendored (and committed) for the Android build,
# since it's just fixed-width int typedefs with no platform dependency.
cp "$RSDK_DIR/dependencies/android/libogg/include/ogg/config_types.h" "$RSDK_DIR/dependencies/emscripten/libogg/include/ogg/config_types.h"
rm -rf "$OGG_TMP"

echo "Vendoring libtheora (pinned @ $THEORA_COMMIT) — used by Video.cpp's cutscene playback, also no system package..."
THEORA_TMP="$(mktemp -d)"
git clone --quiet https://github.com/xiph/theora.git "$THEORA_TMP"
git -C "$THEORA_TMP" checkout --quiet "$THEORA_COMMIT"
# THEORA_DIR is hardcoded to dependencies/android/libtheora by the shared
# (non-platform-specific) CMakeLists.txt regardless of which platform is
# actually building, so that's where it needs to live even for our
# Emscripten build.
mkdir -p "$RSDK_DIR/dependencies/android/libtheora/lib" "$RSDK_DIR/dependencies/android/libtheora/include/theora"
cp "$THEORA_TMP"/lib/*.c "$THEORA_TMP"/lib/*.h "$RSDK_DIR/dependencies/android/libtheora/lib/"
cp "$THEORA_TMP"/include/theora/*.h "$RSDK_DIR/dependencies/android/libtheora/include/theora/"
# RSDKv5's own top-level CMakeLists.txt hardcodes cpu.c in COMPILE_THEORA's
# file list, but upstream xiph/theora has no such file (state.c just sets
# cpu_flags = 0 directly, no oc_cpu_flags_get() call to satisfy) — an empty
# translation unit satisfies the reference harmlessly.
touch "$RSDK_DIR/dependencies/android/libtheora/lib/cpu.c"
rm -rf "$THEORA_TMP"

echo "Patching RetroEngine.hpp to add an Emscripten platform (RETRO_EMSCRIPTEN)..."
python3 - "$RSDK_DIR/RSDKv5/RSDK/Core/RetroEngine.hpp" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. New platform constant, alongside RETRO_WIN/RETRO_LINUX/etc.
anchor = "#define RETRO_ANDROID (7)\n#define RETRO_UWP     (8)\n"
assert content.count(anchor) == 1
content = content.replace(anchor, anchor + "#define RETRO_EMSCRIPTEN (9)\n", 1)

# 2. Auto-detection: emcc defines __EMSCRIPTEN__ (and __unix__, but NOT
# __linux__), so without this it would fall through to the final #else
# (RETRO_WIN, pulling in <windows.h> — a hard compile error).
anchor = (
    "#elif defined __linux__\n"
    "#define RETRO_PLATFORM   (RETRO_LINUX)\n"
    "#define RETRO_DEVICETYPE (RETRO_STANDARD)\n"
    "#else\n"
)
assert content.count(anchor) == 1
replacement = (
    "#elif defined __EMSCRIPTEN__\n"
    "#define RETRO_PLATFORM   (RETRO_EMSCRIPTEN)\n"
    "#define RETRO_DEVICETYPE (RETRO_STANDARD)\n"
    + anchor
)
content = content.replace(anchor, replacement, 1)

# 3. Force the SDL2 render/input/audio backends for this platform (mirrors
# the OSX/iOS branch just above it — Emscripten only realistically supports
# SDL2 here, not GLFW/EGL/MiniAudio).
anchor = (
    "#undef RETRO_INPUTDEVICE_SDL2\n"
    "#define RETRO_INPUTDEVICE_SDL2 (1)\n"
    "\n"
    "#endif\n"
    "\n"
    "#if RETRO_PLATFORM == RETRO_WIN || RETRO_PLATFORM == RETRO_UWP\n"
)
assert content.count(anchor) == 1
replacement = (
    "#undef RETRO_INPUTDEVICE_SDL2\n"
    "#define RETRO_INPUTDEVICE_SDL2 (1)\n"
    "\n"
    "#elif RETRO_PLATFORM == RETRO_EMSCRIPTEN\n"
    "\n"
    "#undef RETRO_RENDERDEVICE_SDL2\n"
    "#define RETRO_RENDERDEVICE_SDL2 (1)\n"
    "\n"
    "#undef RETRO_AUDIODEVICE_SDL2\n"
    "#define RETRO_AUDIODEVICE_SDL2 (1)\n"
    "\n"
    "#undef RETRO_INPUTDEVICE_SDL2\n"
    "#define RETRO_INPUTDEVICE_SDL2 (1)\n"
    "\n"
    "#endif\n"
    "\n"
    "#if RETRO_PLATFORM == RETRO_WIN || RETRO_PLATFORM == RETRO_UWP\n"
)
content = content.replace(anchor, replacement, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Patching RetroEngine.cpp so its main loop runs under Emscripten without Asyncify..."
python3 - "$RSDK_DIR/RSDKv5/RSDK/Core/RetroEngine.cpp" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. #include <emscripten.h> for emscripten_set_main_loop/cancel_main_loop.
anchor = "#if RETRO_PLATFORM == RETRO_ANDROID\n#include <jni.h>\n#include <unistd.h>\n#endif\n"
assert content.count(anchor) == 1
content = content.replace(anchor, anchor + "\n#ifdef __EMSCRIPTEN__\n#include <emscripten.h>\n#endif\n", 1)

# 2. Forward declarations for the two functions RunRetroEngine() is about to
# be split into (see below).
anchor = "RetroEngine RSDK::engine = RetroEngine();\n\nint32 RSDK::RunRetroEngine(int32 argc, char *argv[])\n"
assert content.count(anchor) == 1
content = content.replace(
    anchor,
    "RetroEngine RSDK::engine = RetroEngine();\n\n"
    "static void RunRetroEngineFrame();\n"
    "static void ShutdownRetroEngine();\n\n"
    "int32 RSDK::RunRetroEngine(int32 argc, char *argv[])\n",
    1,
)

# 3. RunRetroEngine()'s main loop is a plain native-style while() that
# busy-waits on CheckFPSCap() -- fine natively (the OS scheduler doesn't
# care), but under Emscripten that would hot-spin the browser's one and only
# thread. An Asyncify-based emscripten_sleep() yield was tried first (much
# smaller diff, keeping the while() loop as-is) but it caused real "function
# signature mismatch" crashes once actual gameplay was reached -- a known
# class of Asyncify bug around indirect calls through RSDK's function-
# pointer-heavy object/mod dispatch. So instead, the loop body becomes an
# emscripten_set_main_loop() callback: the browser paces the calls itself
# (via requestAnimationFrame, fps=0 below), CheckFPSCap() early-returns on
# ticks faster than the target rate, and every old `continue` (skip to next
# iteration) becomes a `return` (skip to the next call of this function).
anchor = (
    "    RenderDevice::InitFPSCap();\n"
    "\n"
    "    while (RenderDevice::isRunning) {\n"
    "        RenderDevice::ProcessEvents();\n"
    "\n"
    "        if (!RenderDevice::isRunning)\n"
    "            break;\n"
    "\n"
    "        if (RenderDevice::CheckFPSCap()) {\n"
    "            RenderDevice::UpdateFPSCap();\n"
    "\n"
    "            AudioDevice::FrameInit();\n"
    "\n"
    "#if RETRO_REV02\n"
    "            SKU::userCore->FrameInit();\n"
    "\n"
    "            if (SKU::userCore->CheckEnginePause())\n"
    "                continue;\n"
)
assert content.count(anchor) == 1
replacement = (
    "    RenderDevice::InitFPSCap();\n"
    "\n"
    "#ifdef __EMSCRIPTEN__\n"
    "    emscripten_set_main_loop(RunRetroEngineFrame, 0, 1);\n"
    "#else\n"
    "    while (RenderDevice::isRunning)\n"
    "        RunRetroEngineFrame();\n"
    "#endif\n"
    "\n"
    "    ShutdownRetroEngine();\n"
    "\n"
    "    return 0;\n"
    "}\n"
    "\n"
    "#ifdef __EMSCRIPTEN__\n"
    "static void StopEmscriptenMainLoop()\n"
    "{\n"
    "    emscripten_cancel_main_loop();\n"
    "    ShutdownRetroEngine();\n"
    "}\n"
    "static unsigned long long emsCurTicks = 0;\n"
    "static unsigned long long emsPrevTicks = 0;\n"
    "#endif\n"
    "\n"
    "static void RunRetroEngineFrame()\n"
    "{\n"
    "    RenderDevice::ProcessEvents();\n"
    "\n"
    "    if (!RenderDevice::isRunning) {\n"
    "#ifdef __EMSCRIPTEN__\n"
    "        StopEmscriptenMainLoop();\n"
    "#endif\n"
    "        return;\n"
    "    }\n"
    "\n"
    "#ifdef __EMSCRIPTEN__\n"
    "    unsigned long long targetFreq = SDL_GetPerformanceFrequency() / videoSettings.refreshRate;\n"
    "    unsigned long long curTime = SDL_GetPerformanceCounter();\n"
    "    if (emsPrevTicks == 0) emsPrevTicks = curTime;\n"
    "    emsCurTicks += (curTime - emsPrevTicks);\n"
    "    emsPrevTicks = curTime;\n"
    "    if (emsCurTicks > targetFreq * 4) emsCurTicks = targetFreq * 4;\n"
    "    if (emsCurTicks + (targetFreq / 8) >= targetFreq && emsCurTicks < targetFreq) emsCurTicks = targetFreq;\n"
    "    if (emsCurTicks < targetFreq) return;\n"
    "    int logicLoops = 0;\n"
    "    while (emsCurTicks >= targetFreq && logicLoops < 4) {\n"
    "        emsCurTicks -= targetFreq;\n"
    "        logicLoops++;\n"
    "#else\n"
    "    if (RenderDevice::CheckFPSCap()) {\n"
    "        RenderDevice::UpdateFPSCap();\n"
    "#endif\n"
    "\n"
    "        AudioDevice::FrameInit();\n"
    "\n"
    "#if RETRO_REV02\n"
    "        SKU::userCore->FrameInit();\n"
    "\n"
    "        if (SKU::userCore->CheckEnginePause())\n"
    "            continue;\n"
)
content = content.replace(anchor, replacement, 1)

# `continue` still works: the frame body is inside the new catch-up while loop.

# 4. Close RunRetroEngineFrame() where the while loop used to close, and turn
# the old inline "// Shutdown" tail into its own function (called both from
# the native while-loop path above and from StopEmscriptenMainLoop()).
anchor = (
    "            RenderDevice::FlipScreen();\n"
    "        }\n"
    "    }\n"
    "\n"
    "    // Shutdown\n"
    "\n"
    "    ReleaseInputDevices();\n"
    "    AudioDevice::Release();\n"
    "    RenderDevice::Release(false);\n"
    "    SaveSettingsINI(false);\n"
    "    SKU::ReleaseUserCore();\n"
    "    ReleaseStorage();\n"
    "#if RETRO_USE_MOD_LOADER\n"
    "    UnloadMods();\n"
    "#endif\n"
    "\n"
    "    Link::Close(gameLogicHandle);\n"
    "    gameLogicHandle = NULL;\n"
    "\n"
    "    if (engine.consoleEnabled)\n"
    "        ReleaseConsole();\n"
    "\n"
    "    return 0;\n"
    "}\n"
)
assert content.count(anchor) == 1
replacement = (
    "        RenderDevice::FlipScreen();\n"
    "    }\n"
    "}\n"
    "\n"
    "static void ShutdownRetroEngine()\n"
    "{\n"
    "    ReleaseInputDevices();\n"
    "    AudioDevice::Release();\n"
    "    RenderDevice::Release(false);\n"
    "    SaveSettingsINI(false);\n"
    "    SKU::ReleaseUserCore();\n"
    "    ReleaseStorage();\n"
    "#if RETRO_USE_MOD_LOADER\n"
    "    UnloadMods();\n"
    "#endif\n"
    "\n"
    "    Link::Close(gameLogicHandle);\n"
    "    gameLogicHandle = NULL;\n"
    "\n"
    "    if (engine.consoleEnabled)\n"
    "        ReleaseConsole();\n"
    "}\n"
)
content = content.replace(anchor, replacement, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Patching SDL2AudioDevice.hpp to load music streams synchronously (no threads under Emscripten)..."
python3 - "$RSDK_DIR/RSDKv5/RSDK/Audio/SDL2/SDL2AudioDevice.hpp" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# Music is streamed: the game always calls PlayStream(..., loadASync=true),
# which this backend services with SDL_CreateThread(LoadStream). This build
# has no -pthread, so under Emscripten SDL_CreateThread fails, LoadStream
# never runs, and the channel stays parked in CHANNEL_LOADING_STREAM -- music
# is silent while SFX (loaded synchronously up front) still play. Loading
# synchronously is safe and cheap here: LoadStream just reads the .ogg out of
# the MEMFS-preloaded datapack and opens the stb_vorbis stream; the actual
# decoding stays incremental inside the audio callback.
anchor = (
    "        if (async)\n"
    "            SDL_CreateThread((SDL_ThreadFunction)LoadStream, \"LoadStream\", (void *)channel);\n"
    "        else\n"
    "            LoadStream(channel);\n"
)
assert content.count(anchor) == 1
replacement = (
    "#ifdef __EMSCRIPTEN__\n"
    "        // No threads in this build: async stream loads would silently never\n"
    "        // run (SDL_CreateThread fails), leaving music channels stuck in\n"
    "        // CHANNEL_LOADING_STREAM. Load inline instead.\n"
    "        (void)async;\n"
    "        LoadStream(channel);\n"
    "#else\n"
    + anchor
    + "#endif\n"
)
content = content.replace(anchor, replacement, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
PYEOF

echo "Patching function-pointer signature mismatches (wasm call_indirect traps)..."
# Native ABIs tolerate calling a function through a pointer whose type doesn't
# exactly match the function's real signature (the stray return value just sits
# ignored in a register); wasm's call_indirect validates the signature at every
# call and traps with "function signature mismatch" instead. An earlier build
# papered over this with -sEMULATE_FUNCTION_POINTER_CASTS=1, which routes EVERY
# indirect call in the program through a runtime-adapting wrapper -- a large
# constant tax on RSDKv5's function-pointer-heavy object dispatch (the hottest
# code in the engine). A full static sweep of the game + engine (all
# StateMachine stores, CREATE_ENTITY data smuggles, cutscene state tables, a
# clang -Wincompatible-function-pointer-types pass over all objects, and a
# slot-by-slot diff of the RSDK/API/Mod function tables between the engine's
# Link.cpp/ModAPI.cpp fill order and the game's GameLink.h struct decls) found
# exactly the mismatches below, so they get fixed at the source and the
# emulation flag dropped entirely.
python3 - "$WORK_DIR" <<'PYEOF'
import sys, pathlib
root = pathlib.Path(sys.argv[1])

def patch(relpath, replacements):
    p = root / relpath
    content = p.read_text(encoding="utf-8")
    for old, new in replacements:
        assert content.count(old) == 1, f"{relpath}: anchor not unique: {old!r}"
        content = content.replace(old, new, 1)
    p.write_text(content, encoding="utf-8")

# GameLink.h declares the engine's function tables for the game's (C) side.
# Five API-table entries and one RSDK-table entry declare the wrong return
# type vs. what the v5U engine actually registers (UserStorage.hpp /
# Drawing.hpp) -- the API.TryAuth()/TryInitStorage()/LoadUserFile() calls fire
# during menu + save init, which is exactly where gameplay crashed. C callers
# may freely ignore the now-declared return value, so this changes nothing on
# other platforms.
patch("SonicMania/GameLink.h", [
    ("    void (*TryAuth)(void);",
     "    int32 (*TryAuth)(void);"),
    ("    void (*TryInitStorage)(void);",
     "    int32 (*TryInitStorage)(void);"),
    ("    void (*LoadUserFile)(const char *name, void *buffer, uint32 size, void (*callback)(int32 status)); // load user file from game dir",
     "    bool32 (*LoadUserFile)(const char *name, void *buffer, uint32 size, void (*callback)(int32 status)); // load user file from game dir"),
    ("    void (*SaveUserFile)(const char *name, void *buffer, uint32 size, void (*callback)(int32 status), bool32 compressed); // save user file to game dir",
     "    bool32 (*SaveUserFile)(const char *name, void *buffer, uint32 size, void (*callback)(int32 status), bool32 compressed); // save user file to game dir"),
    ("    void (*DeleteUserFile)(const char *name, void (*callback)(int32 status)); // delete user file from game dir",
     "    bool32 (*DeleteUserFile)(const char *name, void (*callback)(int32 status)); // delete user file from game dir"),
    # Engine's SetScreenSize returns void; no game code reads a return value
    # (it currently has no callers at all), but keep the decl truthful so any
    # future caller doesn't trap.
    ("    int32 (*SetScreenSize)(uint8 screenID, uint16 width, uint16 height);",
     "    void (*SetScreenSize)(uint8 screenID, uint16 width, uint16 height);"),
])

# CPZBoss parks itself in a state that just polls CheckMatchReset() -- but
# CheckMatchReset returns bool32, and states run through void(*)(void).
# Give the state its own correctly-typed wrapper.
patch("SonicMania/Objects/CPZ/CPZBoss.c", [
    ("bool32 CPZBoss_CheckMatchReset(void)\n{",
     "static void CPZBoss_State_CheckMatchReset(void) { CPZBoss_CheckMatchReset(); }\n\n"
     "bool32 CPZBoss_CheckMatchReset(void)\n{"),
    ("            self->state = (Type_StateMachine)CPZBoss_CheckMatchReset;",
     "            self->state = CPZBoss_State_CheckMatchReset;"),
])

# Cutscene states are stored and invoked as bool32(*)(EntityCutsceneSeq *);
# this one alone is declared without the host parameter.
patch("SonicMania/Objects/GHZ/GHZCutsceneK.c", [
    ("bool32 GHZCutsceneK_Cutscene_None(void)",
     "bool32 GHZCutsceneK_Cutscene_None(EntityCutsceneSeq *host)"),
])
patch("SonicMania/Objects/GHZ/GHZCutsceneK.h", [
    ("bool32 GHZCutsceneK_Cutscene_None(void);",
     "bool32 GHZCutsceneK_Cutscene_None(EntityCutsceneSeq *host);"),
])
PYEOF

echo "Writing dependencies/RSDKv5/platforms/Emscripten.cmake..."
cat << 'EOF' > "$RSDK_DIR/platforms/Emscripten.cmake"
add_executable(RetroEngine ${RETRO_FILES})

set(RETRO_SUBSYSTEM "SDL2" CACHE STRING "The subsystem to use")

# Neither libogg nor libtheora (used for Video.cpp's cutscene playback) ship
# system packages under Emscripten, unlike a real Linux/pkg-config setup, so
# always compile them from source like Android does. DEP_PATH controls where
# COMPILE_OGG looks (dependencies/${DEP_PATH}/libogg); THEORA_DIR is hardcoded
# to dependencies/android/libtheora by the top-level CMakeLists.txt regardless
# of platform, so that's where the build script vendors theora's source too.
set(DEP_PATH emscripten)
set(COMPILE_OGG TRUE)
set(COMPILE_THEORA TRUE)

if(NOT DEFINED GAME_DATA_DIR)
    set(GAME_DATA_DIR ${CMAKE_SOURCE_DIR})
endif()

set_target_properties(RetroEngine PROPERTIES SUFFIX ".js")

target_compile_options(RetroEngine PRIVATE -sUSE_SDL=2)

target_link_options(RetroEngine PRIVATE
    -sUSE_SDL=2
    # CMAKE_BUILD_TYPE=Release only puts -O3 on the COMPILE lines; emcc's link
    # stage (wasm-opt passes + JS glue minification) runs at -O0 unless the
    # optimization level is repeated here.
    -O3
    # No -sEMULATE_FUNCTION_POINTER_CASTS: the function-pointer signature
    # mismatches that made wasm's call_indirect trap ("function signature
    # mismatch" during menus/gameplay) are fixed at the source by the
    # signature-mismatch patch step in build.sh, so every indirect call --
    # the hottest path in RSDKv5's object dispatch -- stays a plain
    # call_indirect instead of going through fpcast-emu thunks.
    # NOT ALLOW_MEMORY_GROWTH: once wasm memory has `maximum > initial` (what
    # growth requires), Chromium backs Memory.buffer with a "resizable"
    # ArrayBuffer, and its WebGL/TextDecoder APIs outright refuse to read from
    # one ("...must not be resizable") -- hit both in glShaderSource's string
    # conversion and in glTexSubImage2D's pixel upload during a first pass.
    # A fixed-size heap (initial == maximum) avoids the resizable path
    # entirely, at the cost of a hard OOM instead of graceful growth if this
    # ever proves too small.
    -sTOTAL_MEMORY=536870912
    -sSTACK_SIZE=5242880
    -sFORCE_FILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=[FS,callMain]
    "SHELL:--preload-file ${GAME_DATA_DIR}/Data.rsdk@Data.rsdk"
    "SHELL:--preload-file ${GAME_DATA_DIR}/Settings.ini@Settings.ini"
)
EOF

echo "Copying Data.rsdk and writing Settings.ini into build directory..."
cp "$RSDKV5_DATA_RSDK" "$WORK_DIR/Data.rsdk"
cat << 'EOF' > "$WORK_DIR/Settings.ini"
[Game]
dataFile=Data.rsdk
devMenu=0
language=0
region=-1

[Video]
windowed=1
border=1
exclusiveFS=0
vsync=0
tripleBuffering=0
pixWidth=424
winWidth=424
winHeight=240
fsWidth=0
fsHeight=0
refreshRate=60
shaderSupport=0
screenShader=0

[Audio]
streamsEnabled=1
streamVolume=0.8
sfxVolume=1.0
EOF

echo "Configuring + building (emcmake cmake, GAME_STATIC=ON, output name rsdkv5)..."
# -DRETRO_OUTPUT_NAME=rsdkv5 renames the emitted RSDKv5U.{js,wasm,data} triple at
# the source: the JS glue hardcodes its .wasm/.data siblings' names, so renaming
# files after the fact would break its internal references.
( cd "$WORK_DIR" && \
  emcmake cmake -B build \
    -DGAME_STATIC=ON \
    -DPLATFORM=Emscripten \
    -DRETRO_OUTPUT_NAME=rsdkv5 \
    -DCMAKE_BUILD_TYPE=Release && \
  cmake --build build -j"$(nproc 2>/dev/null || echo 4)" )

echo "Copying build output to $DIST_DIR/rsdkv5..."
ENGINE_JS="$(find "$WORK_DIR/build" -name 'rsdkv5.js' -print -quit)"
if [[ -z "$ENGINE_JS" ]]; then
  echo "build.sh: rsdkv5.js not found under $WORK_DIR/build — RETRO_OUTPUT_NAME may" >&2
  echo "  not have taken effect. Emitted js/wasm/data files:" >&2
  find "$WORK_DIR/build" \( -name '*.js' -o -name '*.wasm' -o -name '*.data' \) -not -path '*CMakeFiles*' >&2 || true
  exit 1
fi
ENGINE_BUILD_DIR="$(dirname "$ENGINE_JS")"
cp "$ENGINE_BUILD_DIR/rsdkv5.js" "$ENGINE_BUILD_DIR/rsdkv5.wasm" "$ENGINE_BUILD_DIR/rsdkv5.data" "$DIST_DIR/rsdkv5/"

echo "Build complete. Artifacts:"
ls -la "$DIST_DIR/rsdkv5"

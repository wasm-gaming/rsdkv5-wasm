# RSDKv5 WASM build — shared core (both approaches)

Everything in this file is **identical on both branches** ([Approach A](wasm-build-approach-a-static-preload.md),
[Approach B](wasm-build-approach-b-sdk-contract.md)). It is ported verbatim
(adapting paths) from the proven recipe at `.peers/build-rsdkv5-docker.sh`
(play.germade). **These steps are non-negotiable** — each was found by debugging a
real failure; skipping any one reproduces a known crash/hang.

## Background: why v5 is not like v3/v4

| | v3 (`rsdkv3-wasm`) | v4 (`rsdkv4-wasm`) | v5 (this repo) |
|---|---|---|---|
| Upstream WASM support | community fork exists | community fork (`mattConn`) exists | **none upstream** |
| Build system | Makefile (sed-patched) | Makefile (sed-patched) | **CMake** |
| Engine ↔ game | combined | combined | **split**: engine + game logic |
| Filesystem | MEMFS/WASMFS | WASMFS + OPFS | **IDBFS** (or preload) |

Two facts drove the whole design:

1. **RSDKv5-Decompilation has no Emscripten platform upstream** — only
   Windows/Linux/Android/Switch. An Emscripten platform + several engine patches
   must be authored.
2. **The engine is game-agnostic; the game (Sonic Mania) is separate.** A
   standalone game side module (`Game.wasm`, `-sSIDE_MODULE=2`) is the "clean"
   split, **but a complete WASM Sonic Mania game module is not a finished public
   artifact.** The only recipe proven to actually run compiles the game
   **statically into the engine** via `-DGAME_STATIC=ON`. Both approaches
   therefore use `GAME_STATIC=ON` and build from the **Sonic Mania decompilation**
   (which vendors RSDKv5 as a submodule), not from the engine repo alone.

> Consequence for both branches: because the game is statically linked, the
> produced binary **is Sonic-Mania-specific**. Approach B keeps a game-agnostic
> *SDK surface* (`createRSDKv5` factory, runtime data mount), but the `.wasm`
> itself still has Mania compiled in. A truly game-agnostic engine `.wasm` would
> require the finished side-module path, which is out of scope until that exists.

## Base repos + toolchain (both approaches)

| Repo | Role | Pin |
|---|---|---|
| [RSDKModding/Sonic-Mania-Decompilation](https://github.com/RSDKModding/Sonic-Mania-Decompilation) | Primary clone — game code; vendors the engine as a submodule at `dependencies/RSDKv5` | `9dc69942…` |
| [RSDKModding/RSDKv5-Decompilation](https://github.com/RSDKModding/RSDKv5-Decompilation) | The engine (RSDKv5U). Arrives via `submodule update --init --recursive`, never cloned directly | via the Mania pin |
| [xiph/ogg](https://github.com/xiph/ogg) | Vendored source (no system package under Emscripten) | `06a5e026…` |
| [xiph/theora](https://github.com/xiph/theora) | Vendored source — cutscene playback (`Video.cpp`) | `28fd5ec7…` |

(RSDKModding is the successor org to Rubberduckycooly's original repos. The
`Jdsle/RSDKv5-Decompilation@web` / RSDK-Library fork — MAIN_MODULE + pthreads +
`Game.wasm` side module — was investigated and **rejected**: no finished public
`Game.wasm` exists.)

**Toolchain:** the proven build (2026-07-05) used `emscripten/emsdk:latest`,
which at that date was **Emscripten 6.0.2** (image `644883f58ca1`, created
2026-07-01). Pin `EMSDK_IMAGE` to that rather than `latest` — emsdk updates have
broken flag combinations before.

## Source + pinned deps

```sh
# Sonic Mania decomp (vendors RSDKv5 at dependencies/RSDKv5)
SONIC_MANIA_COMMIT=9dc699428420d752af9767bdb13f585ee0881bc0
git clone https://github.com/RSDKModding/Sonic-Mania-Decompilation.git "$WORK_DIR"
git -C "$WORK_DIR" checkout "$SONIC_MANIA_COMMIT"
git -C "$WORK_DIR" submodule update --init --recursive   # <-- brings in RSDKv5 + tinyxml2/stb_vorbis
```

`RSDK_DIR="$WORK_DIR/dependencies/RSDKv5"`

## Vendor libogg + libtheora (no system packages under Emscripten)

- **libogg** `@06a5e0262cdc28aa4ae6797627a783b5010440f0` (`xiph/ogg`)
  → `$RSDK_DIR/dependencies/emscripten/libogg/{src,include/ogg}`
  (copy `bitwise.c framing.c crctable.h`, `ogg.h os_types.h`; reuse Android's
  committed `config_types.h`).
- **libtheora** `@28fd5ec77f0ad0e07a371cef1047828116f6bd8a` (`xiph/theora`)
  → `$RSDK_DIR/dependencies/android/libtheora/{lib,include/theora}` (THEORA_DIR is
  **hardcoded to `dependencies/android/libtheora`** by the shared CMakeLists,
  regardless of platform). `touch .../lib/cpu.c` — the CMakeLists lists `cpu.c`
  but upstream theora has no such file (state.c sets `cpu_flags = 0` directly).

## Engine patches (python anchored-replace, `assert count == 1`)

1. **`RSDKv5/RSDK/Core/RetroEngine.hpp`** — add `#define RETRO_EMSCRIPTEN (9)`;
   detect `__EMSCRIPTEN__` (emcc defines `__unix__` but **not** `__linux__`, so
   without this it falls through to `RETRO_WIN` → `<windows.h>` → hard error);
   force the SDL2 render/audio/input backends for the new platform.
2. **`RSDKv5/RSDK/Core/RetroEngine.cpp`** — replace the native busy-`while`
   main loop with `emscripten_set_main_loop(RunRetroEngineFrame, 0, 1)`
   (fps=0 → rAF-paced; `CheckFPSCap()` early-returns). Split the loop body into
   `RunRetroEngineFrame()` + `ShutdownRetroEngine()`; add
   `emscripten_cancel_main_loop()` on exit. **Asyncify was tried and rejected** —
   it crashed with function-signature-mismatch on RSDK's indirect object dispatch.
3. **`RSDKv5/RSDK/Audio/SDL2/SDL2AudioDevice.hpp`** — load music streams
   **synchronously** under Emscripten (`SDL_CreateThread` fails with no `-pthread`,
   leaving channels stuck in `CHANNEL_LOADING_STREAM` → silent music).
4. **Function-pointer signature fixes** (so wasm `call_indirect` doesn't trap;
   lets us **drop `-sEMULATE_FUNCTION_POINTER_CASTS`**, which otherwise taxes the
   hottest path):
   - `SonicMania/GameLink.h`: `TryAuth`/`TryInitStorage` → `int32`;
     `LoadUserFile`/`SaveUserFile`/`DeleteUserFile` → `bool32`;
     `SetScreenSize` → `void`.
   - `SonicMania/Objects/CPZ/CPZBoss.c`: wrap `CPZBoss_CheckMatchReset` (returns
     `bool32`) in a `void(void)` state trampoline.
   - `SonicMania/Objects/GHZ/GHZCutsceneK.{c,h}`: `GHZCutsceneK_Cutscene_None`
     takes `EntityCutsceneSeq *host`, not `void`.

## CMake build invocation

```sh
docker run --rm -v "$WORK_DIR:/workspace" -w /workspace emscripten/emsdk:latest \
  bash -c "emcmake cmake -B build -DGAME_STATIC=ON -DPLATFORM=Emscripten \
           -DCMAKE_BUILD_TYPE=Release && cmake --build build -j\$(nproc)"
```

Artifacts land at `build/dependencies/RSDKv5/RSDKv5U.{js,wasm[,data]}`.

`-DGAME_STATIC=ON` must be **explicit**: the top-level CMakeLists only forces it
ON for non-Windows/non-Unix platforms, and Emscripten's toolchain sets `UNIX=1` —
left alone it defaults OFF, building the game as a separate shared library that
`RetroEngine` would `dlopen` at runtime (Emscripten dynamic linking, exactly what
we're avoiding).

## Memory flags (shared, learned the hard way)

- `-sTOTAL_MEMORY=536870912` (512 MB), `-sSTACK_SIZE=5242880`.
- **No `-sALLOW_MEMORY_GROWTH`.** With `maximum > initial`, Chromium backs
  `Memory.buffer` with a *resizable* `ArrayBuffer`, and WebGL/`TextDecoder` refuse
  to read from one ("...must not be resizable") — hit in `glShaderSource` and
  `glTexSubImage2D`. Fixed heap avoids it, at the cost of hard OOM vs. growth.
- Repeat `-O3` on the **link** line — `CMAKE_BUILD_TYPE=Release` only optimizes
  compile lines; emcc's link stage (wasm-opt + JS-glue minify) is `-O0` otherwise.
- `-sFORCE_FILESYSTEM=1`.

## Provenance: how "proven" was established

The reference recipe was verified on 2026-07-05 (play.germade sessions
`2026-07-05_05h00.sonic-mania-integration` and `…_20h00.sonic-mania-perf-fpcast`):
clean Docker build from a **fresh clone**, then headless Chromium driven from
boot → menus → **Studiopolis Zone gameplay** with sustained input, plus attract
demo and pause — past the exact point earlier builds trapped. Joshua also played
it by hand. Final `.wasm` is ~4.85 MB (dropping fpcast-emu shrank it 23%).

Known **unverified** areas (carry over to both branches):
- Theora cutscene playback (compiled in, never exercised).
- Real gamepad hardware (the shared `game-input.js` gamepad→keyboard translator
  with `window.__gamepadKeyMap = 'rsdkv5'` passed synthetic-pad tests only; the
  key map matches `defaultKeyMaps` in `RSDKv5/RSDK/User/Core/UserCore.cpp`).
- Memory headroom of the fixed 512 MB heap across larger/later levels.

## Verification (both branches)

- `make build-sdk` must stay green (TS half is already fine).
- `make build-wasm` inside `emscripten/emsdk` (Docker) must produce the artifacts.
- `make preview` (sends COOP/COEP) → load the demo, confirm the title screen and
  input. A green compile is **not** proof it runs — drive it in the browser.

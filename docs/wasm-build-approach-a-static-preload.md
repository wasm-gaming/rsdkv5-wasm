# Approach A — Mirror the proven recipe (static + preload)

**Goal:** the lowest-risk path — reproduce exactly what already runs
(`.peers/build-rsdkv5-docker.sh`), then adapt the repo around it.

Builds on the [shared core](wasm-build-shared-core.md) (sources, vendored deps,
engine patches, CMake invocation, memory flags) — read that first. The other
option is [Approach B](wasm-build-approach-b-sdk-contract.md).

## `platforms/Emscripten.cmake` (as in the reference)

```cmake
add_executable(RetroEngine ${RETRO_FILES})
set(RETRO_SUBSYSTEM "SDL2" CACHE STRING "The subsystem to use")
set(DEP_PATH emscripten)
set(COMPILE_OGG TRUE)
set(COMPILE_THEORA TRUE)
set_target_properties(RetroEngine PROPERTIES SUFFIX ".js")
target_compile_options(RetroEngine PRIVATE -sUSE_SDL=2)
target_link_options(RetroEngine PRIVATE
    -sUSE_SDL=2 -O3
    -sTOTAL_MEMORY=536870912 -sSTACK_SIZE=5242880 -sFORCE_FILESYSTEM=1
    -sEXPORTED_RUNTIME_METHODS=[FS,callMain]
    "SHELL:--preload-file ${GAME_DATA_DIR}/Data.rsdk@Data.rsdk"
    "SHELL:--preload-file ${GAME_DATA_DIR}/Settings.ini@Settings.ini")
```

- Data is **baked in** → a third artifact `RSDKv5U.data` (the preload package).
- Output is a **plain factory-less module**; the engine auto-runs `main()` and
  reads `Settings.ini` → `dataFile=Data.rsdk` from the preloaded MEMFS.
- **Single-threaded** → **no COOP/COEP required** → GitHub Pages can host it.

## Repo changes required (this is the cost of Approach A)

- **`build.sh`**: also needs `Data.rsdk` present at build time (the reference reads
  it from `game-assets/sonic-mania/Data.rsdk`). Decide where this repo sources it
  (env var / `dist/Data.rsdk`); it is git-ignored and must not be committed.
- **`dist/rsdkv5/`** gains `rsdkv5.js`, `rsdkv5.wasm`, **`rsdkv5.data`**. Update
  `package.json` `files`, the manifest `artifacts`, and both CI release file lists
  to include `.data`.
- **`rsdkv5.sdk.ts`**: **remove** the runtime-mount path (`Module.FS.writeFile`,
  `mountWorkingDir`, `purgeStorage`, `dataProvider`/`settingsProvider`,
  `callMain(['UsingCWD'])`). The module is not a `createRSDKv5` ES6 factory, so the
  `import createRSDKv5` + `mod.default(...)` call goes away or is replaced by the
  reference's loader shape. `load()` becomes "instantiate, it self-runs."
- **`rsdkv5.manifest.ts`**: drop the `data`/`settings` runtime assets (they're
  preloaded), and stop describing the engine as game-agnostic. Add the `.data`
  artifact.
- **Demo (`src/demo/`)**: the drag-and-drop/pick-your-own-`Data.rsdk` fallback no
  longer applies (data is compiled in) — simplify to "load and run."
- **CI Pages job**: stays valid (single-threaded, no COI needed).

## Pros / cons

- ✅ Proven to run; lowest risk. ✅ Pages-hostable as-is.
- ❌ Binary is Sonic-Mania-specific with data baked in (bigger artifact, can't swap
  data at runtime). ❌ Largest churn to SDK/manifest/demo. ❌ Abandons the
  game-agnostic/runtime-mount design this repo was scaffolded around.

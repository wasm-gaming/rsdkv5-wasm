# Approach B — Keep this repo's SDK contract (factory + runtime mount)

**Goal:** preserve `rsdkv5.sdk.ts` / manifest / demo as written (`createRSDKv5`
ES6 factory, `Data.rsdk` written to the FS at runtime), changing only the build.

Builds on the [shared core](wasm-build-shared-core.md) (sources, vendored deps,
engine patches, CMake invocation, memory flags) — read that first. The other
option is [Approach A](wasm-build-approach-a-static-preload.md).

## `platforms/Emscripten.cmake` (diverges from the reference here)

Same as Approach A **except** the `target_link_options`:

```cmake
target_link_options(RetroEngine PRIVATE
    -sUSE_SDL=2 -O3
    -sTOTAL_MEMORY=536870912 -sSTACK_SIZE=5242880 -sFORCE_FILESYSTEM=1
    # --- ES6 factory expected by rsdkv5.sdk.ts ---
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createRSDKv5
    -sINVOKE_RUN=0
    "-sEXPORTED_RUNTIME_METHODS=['callMain','FS','ccall','cwrap']"
    "-sEXPORTED_FUNCTIONS=['_main']"
    # --- NO --preload-file: the SDK mounts data at runtime ---
)
```

- `INVOKE_RUN=0` + exported `callMain` so the SDK can write files **before** boot.
- No `.data` artifact — only `rsdkv5.{js,wasm}`, matching the current manifest.

## Status (2026-07-11): IMPLEMENTED AND VERIFIED

Built with emsdk 6.0.2 (Docker) and driven in headless Chromium: `createRSDKv5()`
factory boots, the SDK runtime-mounts Data.rsdk + Settings.ini under
`/data/<ns>/` + `FS.chdir`, `callMain([])` starts the engine, and the Sonic Mania
developer splash renders with zero console errors. Risks 1–4 below are resolved
(CWD-relative `dataFile=` works; capital-S `Settings.ini` + v5 INI dialect fixed
in the SDK; no `UsingCWD`; MODULARIZE/EXPORT_ES6/INVOKE_RUN=0 coexist with
`emscripten_set_main_loop`). Risk 5 (dev-menu bridge) remains a guarded no-op.
Verified to the splash screen — menus/gameplay not yet driven on this variant.

## Open risks to resolve on this branch (verify with a real build)

1. **Where does the engine read data?** The reference preloads `Data.rsdk` +
   `Settings.ini` at the FS **root** and the engine runs from `/`. This repo's SDK
   writes to `/data/<ns>/` then `Module.FS.chdir(workDir)`. Confirm v5U honors CWD
   for `dataFile`, or write the files where v5U actually looks.
2. **Filename case.** Reference uses **`Settings.ini`** (capital S); the SDK writes
   **`settings.ini`**. Emscripten FS is case-sensitive → align them.
3. **`callMain(['UsingCWD'])`.** `UsingCWD` is a v4-ism. v5U parses different argv
   and uses `Settings.ini` `dataFile=`; the `UsingCWD` arg is likely a no-op or
   wrong — verify what v5U's `main()` expects (probably `callMain([])`).
4. **`MODULARIZE`+`EXPORT_ES6`** interaction with the `emscripten_set_main_loop`
   run model and `INVOKE_RUN=0` — confirm `callMain()` still starts the loop.
5. **Dev-menu bindings.** `rsdkv5.sdk.ts` optionally calls
   `web_devmenu_get_stage_list` / `_load_stage` / `_set_paused` (guarded by
   `typeof`). They don't exist in the engine yet — either add an embind bridge
   (like rsdkv4-wasm's `WebDevMenu.cpp`) or accept the guarded no-ops.

## Repo changes required

- **`build.sh`** only (emit the B-variant cmake, copy `RSDKv5U.js/.wasm` →
  `dist/rsdkv5/rsdkv5.{js,wasm}`). Plus the small SDK path/case/argv fixes in
  items 1–3 above.
- Manifest / `package.json` / CI file lists: **unchanged** (no `.data`).
- **CI Pages job caveat:** this build is still single-threaded (no `-pthread`), so
  Pages hosting is fine. (If a future perf pass adds pthreads, COOP/COEP become
  mandatory and Pages breaks — see `preview-server.py`, which already sends them.)

## Pros / cons

- ✅ Keeps the scaffolded TS SDK / manifest / demo and the runtime-mount UX
  (drag-and-drop your own `Data.rsdk`). ✅ Smaller artifacts (no `.data`).
- ❌ Deviates from the proven data-loading path → must verify items 1–5 with a
  real container build before trusting it. ❌ Still a Mania-static `.wasm` under
  the hood (the factory surface is game-agnostic; the binary isn't).

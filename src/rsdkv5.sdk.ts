// @wasm-gaming/rsdkv5-wasm — SDK entry point (APPROACH A: static + preload).

// Conforms to the wasm-gaming engine contract (github.com/wasm-gaming/engine-specs):
// exports `manifest` (declarative) and `load(config)` (imperative).

// Sonic Mania is compiled STATICALLY into the engine (GAME_STATIC=ON) and
// Data.rsdk / Settings.ini are BAKED IN at build time via --preload-file
// (rsdkv5.data). Nothing is mounted at runtime; `config.assets` is unused.
// The engine module is a plain (non-MODULARIZE) Emscripten build that reads a
// global `Module` object and auto-runs main() once rsdkv5.data is fetched —
// the SDK's job is to stand up that global and inject the script.
//
// Consequences vs. the runtime-mount design (see docs/wasm-build-approach-a-
// static-preload.md): one engine instance per page (the global `Module`),
// no data/settings swapping, no persistence layer, options are build-time.

import type { EngineConfig, EngineInstance } from '@wasm-gaming/engine-specs';
import { manifest } from './rsdkv5.manifest.js';

export { manifest };

/** RSDKv5-specific bridge for the launcher's debug/stage-select UI.
 * NOTE: the current engine build has no WebDevMenu embind bridge (unlike
 * rsdkv4-wasm), so these are guarded no-ops until one is added. */
export interface RsdkDevMenuBridge {
  getStageList(): Array<{ name: string; stages: Array<{ name: string }> }>;
  loadStage(categoryIdx: number, stageIdx: number): void;
  setPaused(paused: boolean): void;
}

export type Rsdkv5Instance = EngineInstance & {
  devMenu: RsdkDevMenuBridge;
};

/**
 * Extra (engine-specific) config on top of the contract's EngineConfig:
 * `dataUrl` overrides where the preload package (rsdkv5.data) is fetched from,
 * mirroring the contract's jsUrl/wasmUrl overrides.
 */
export type Rsdkv5LoadConfig = EngineConfig & {
  dataUrl?: string;
};

let loadedOnce = false;

/** Boot the RSDKv5 engine. */
export async function load(config: Rsdkv5LoadConfig): Promise<Rsdkv5Instance> {
  const { canvas, onEvent } = config;
  if (!canvas) throw new Error('rsdkv5: config.canvas is required');
  // The plain Emscripten output owns one global Module per page; a second
  // load() would silently fight the first over it.
  if (loadedOnce) throw new Error('rsdkv5: only one engine instance per page');
  loadedOnce = true;

  // Emscripten's SDL2 port locates the canvas via document.querySelector('#canvas').
  if (canvas.id !== 'canvas') canvas.id = 'canvas';

  const emit = (e: Parameters<NonNullable<EngineConfig['onEvent']>>[0]) => {
    try { onEvent?.(e); } catch { /* host handler must not break us */ }
  };

  const jsUrl = config.jsUrl ?? new URL('./rsdkv5.js', import.meta.url).href;
  const wasmUrl = config.wasmUrl ?? new URL('./rsdkv5.wasm', import.meta.url).href;
  const dataUrl = config.dataUrl ?? new URL('./rsdkv5.data', import.meta.url).href;

  // RSDKv5 uses the same key map preset used by the shared launcher script.
  if (typeof window !== 'undefined') (window as any).__gamepadKeyMap = manifest.input;

  const Module: any = await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (!settled) { settled = true; reject(err); }
      emit({ type: 'error', error: err });
    };

    const mod: any = {
      canvas,
      locateFile: (path: string) =>
        path.endsWith('.wasm') ? wasmUrl : path.endsWith('.data') ? dataUrl : path,
      print: (...a: unknown[]) => console.log('[rsdkv5]', ...a),
      printErr: (...a: unknown[]) => console.error('[rsdkv5]', ...a),
      onAbort: (reason: unknown) => fail(new Error(`rsdkv5 aborted: ${reason}`)),
      // Fires once the runtime (including the rsdkv5.data preload) is ready,
      // just before the auto-run of main(). main() never returns (it parks in
      // emscripten_set_main_loop), so postRun would never fire — this is the
      // one reliable "ready" hook.
      onRuntimeInitialized: () => {
        if (!settled) { settled = true; resolve(mod); }
      },
    };
    (globalThis as any).Module = mod;

    const script = document.createElement('script');
    script.src = jsUrl;
    script.async = true;
    script.onerror = () => fail(new Error(`rsdkv5: failed to load ${jsUrl}`));
    document.head.appendChild(script);
  });

  emit({ type: 'ready' });

  const setPaused = (paused: boolean) => {
    // No WebDevMenu bridge in this build; fall back to the Emscripten main-loop
    // pause when the glue exposes it (not in EXPORTED_RUNTIME_METHODS, so
    // this is best-effort — the proven flag set is deliberately unchanged).
    if (typeof Module.web_devmenu_set_paused === 'function') {
      Module.web_devmenu_set_paused(paused);
    } else if (paused && typeof Module.pauseMainLoop === 'function') {
      Module.pauseMainLoop();
    } else if (!paused && typeof Module.resumeMainLoop === 'function') {
      Module.resumeMainLoop();
    }
  };

  const devMenu: RsdkDevMenuBridge = {
    getStageList() {
      if (typeof Module.web_devmenu_get_stage_list !== 'function') return [];
      try {
        return JSON.parse(Module.web_devmenu_get_stage_list());
      } catch (e) {
        console.error('[rsdkv5] getStageList failed', e);
        return [];
      }
    },
    loadStage(categoryIdx, stageIdx) {
      if (typeof Module.web_devmenu_load_stage === 'function') {
        Module.web_devmenu_load_stage(categoryIdx | 0, stageIdx | 0);
      }
    },
    setPaused,
  };

  return {
    start() {}, // auto-ran by the module once the preload finished
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    reset() {
      throw new Error('rsdkv5: reset() is not supported — reload the page');
    },
    setInput(preset) {
      if (typeof window !== 'undefined') {
        (window as any).__gamepadKeyMap = preset ?? manifest.input;
      }
    },
    destroy() {
      try { Module.pauseMainLoop?.(); } catch { /* noop */ }
    },
    devMenu,
  };
}

export default { manifest, load };

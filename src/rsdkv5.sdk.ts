// @wasm-gaming/rsdkv5-wasm — SDK entry point.

// Conforms to the wasm-gaming engine contract (github.com/wasm-gaming/engine-specs):
// exports `manifest` (declarative) and `load(config)` (imperative).

// Sonic Mania is built as RSDKv5U (compiled statically into the engine — see
// docs/wasm-build-approach-b-sdk-contract.md). The SDK surface is game-agnostic:
// `Data.rsdk` and `Settings.ini` are mounted at runtime into the FS, then main()
// is started via callMain(). NOTE the capital S: the v5 engine reads
// "Settings.ini" (case-sensitive under the Emscripten FS), unlike v4's
// settings.ini.

import type { EngineConfig, EngineInstance, AssetData } from '@wasm-gaming/engine-specs';
import { manifest } from './rsdkv5.manifest.js';
import { DEFAULT_RSDKV5_OPTIONS, type Rsdkv5Options } from './rsdkv5.options.js';

export { manifest };

const WORK_ROOT = '/data';
const DEFAULT_STORAGE_NAMESPACE = 'default';

/**
 * Serialize engine options into RSDKv5U's Settings.ini format. This is the v5
 * dialect (lowercase keys, 0/1 booleans, `dataFile=` in [Game]) — matching the
 * exact file the proven build preloaded — NOT v4's [Dev]/CamelCase format.
 * `dataFile=Data.rsdk` is load-bearing: it names the pack the engine opens,
 * relative to CWD (the SDK chdir()s into the working dir before callMain).
 */
function buildSettingsIni(options: Rsdkv5Options = {}): string {
  const o = { ...DEFAULT_RSDKV5_OPTIONS, ...options };
  const b = (v: boolean) => (v ? '1' : '0');
  return [
    '[Game]',
    'dataFile=Data.rsdk',
    `devMenu=${b(o.devMenu)}`,
    `language=${o.language | 0}`,
    `region=${o.region | 0}`,
    '',
    '[Video]',
    'windowed=1',
    'border=1',
    'exclusiveFS=0',
    `vsync=${b(o.vsync)}`,
    'tripleBuffering=0',
    'pixWidth=424',
    'winWidth=424',
    'winHeight=240',
    'fsWidth=0',
    'fsHeight=0',
    'refreshRate=60',
    'shaderSupport=0',
    'screenShader=0',
    '',
    '[Audio]',
    'streamsEnabled=1',
    'streamVolume=0.8',
    'sfxVolume=1.0',
    '',
  ].join('\n');
}

function toUint8(x: unknown): Uint8Array | null {
  if (x == null) return null;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('asset must be Uint8Array | ArrayBuffer | string');
}

/** Normalize a user-provided storage namespace into a safe relative path. */
function normalizeStorageNamespace(namespace: unknown): string {
  if (typeof namespace !== 'string' || !namespace.trim()) return DEFAULT_STORAGE_NAMESPACE;

  const cleaned = namespace
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter(Boolean)
    .join('/');

  return cleaned || DEFAULT_STORAGE_NAMESPACE;
}

/** Best-effort mkdir -p for the Emscripten FS layer. */
function ensureDir(Module: any, path: string): void {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    try {
      Module.FS.mkdir(current);
    } catch {
      /* already exists */
    }
  }
}

/** Mount the game working directory. */
function mountWorkingDir(Module: any, storageNamespace: string): { persistent: boolean; workDir: string } {
  const workDir = `${WORK_ROOT}/${storageNamespace}`;
  ensureDir(Module, workDir);
  return { persistent: false, workDir };
}

/** True if `path` exists in the (mounted) filesystem. */
function fileExists(Module: any, path: string): boolean {
  try {
    Module.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Delete a file if present; returns true when something was removed. */
function deleteFileIfExists(Module: any, path: string): boolean {
  if (!fileExists(Module, path)) return false;
  try {
    Module.FS.unlink(path);
    return true;
  } catch {
    return false;
  }
}

/** RSDKv5-specific bridge for the launcher's debug/stage-select UI. */
export interface RsdkDevMenuBridge {
  getStageList(): Array<{ name: string; stages: Array<{ name: string }> }>;
  loadStage(categoryIdx: number, stageIdx: number): void;
  setPaused(paused: boolean): void;
}

export type Rsdkv5Instance = EngineInstance & {
  devMenu: RsdkDevMenuBridge;
  /** True when the working dir is OPFS-backed (persistent) rather than in-memory. */
  persistent: boolean;
  /** Relative storage namespace used under /data (e.g. "sonic-mania"). */
  storageNamespace: string;
  /** Remove persisted game files for this namespace only. */
  purgeStorage(): { data: boolean; settings: boolean };
};

/**
 * Extra (engine-specific) config on top of the contract's EngineConfig: lazy asset
 * providers, invoked only on a cache miss.
 */
export type Rsdkv5LoadConfig = EngineConfig & {
  dataProvider?: () => Promise<AssetData> | AssetData;
  settingsProvider?: () => Promise<AssetData> | AssetData;
  /** Per-game storage folder under /data used for OPFS/WASMFS files. */
  storageNamespace?: string;
};

/** Boot the RSDKv5 engine. */
export async function load(config: Rsdkv5LoadConfig): Promise<Rsdkv5Instance> {
  const { canvas, assets, onEvent } = config;
  const options = config.options as Rsdkv5Options | undefined;
  if (!canvas) throw new Error('rsdkv5: config.canvas is required');

  // Emscripten's SDL2 port locates the canvas via document.querySelector('#canvas').
  if (canvas.id !== 'canvas') canvas.id = 'canvas';

  const emit = (e: Parameters<NonNullable<EngineConfig['onEvent']>>[0]) => {
    try { onEvent?.(e); } catch { /* host handler must not break us */ }
  };

  const jsUrl = config.jsUrl ?? new URL('./rsdkv5.js', import.meta.url).href;
  const wasmUrl = config.wasmUrl ?? new URL('./rsdkv5.wasm', import.meta.url).href;

  // RSDKv5 uses the same key map preset used by the shared launcher script.
  if (typeof window !== 'undefined') (window as any).__gamepadKeyMap = manifest.input;

  const mod: any = await import(/* @vite-ignore */ jsUrl);
  const createRSDKv5 = mod.default;

  const Module: any = await createRSDKv5({
    canvas,
    noInitialRun: true,
    locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
    print: (...a: unknown[]) => console.log('[rsdkv5]', ...a),
    printErr: (...a: unknown[]) => console.error('[rsdkv5]', ...a),
    onAbort: (reason: unknown) =>
      emit({ type: 'error', error: new Error(`rsdkv5 aborted: ${reason}`) }),
  });

  const storageNamespace = normalizeStorageNamespace(config.storageNamespace);
  const { persistent, workDir } = mountWorkingDir(Module, storageNamespace);
  const dataPath = `${workDir}/Data.rsdk`;
  // Capital S: RSDKv5U opens "Settings.ini" and the Emscripten FS is
  // case-sensitive (v4 used lowercase settings.ini — do not copy that here).
  const settingsPath = `${workDir}/Settings.ini`;

  // Data.rsdk — precedence: explicit asset > lazy provider > existing file.
  let dataBytes = toUint8(assets?.data);
  if (!dataBytes && config.dataProvider) {
    dataBytes = toUint8(await config.dataProvider());
  }
  if (dataBytes) {
    Module.FS.writeFile(dataPath, dataBytes);
  } else if (!fileExists(Module, dataPath)) {
    throw new Error('rsdkv5: no Data.rsdk — provide assets.data or dataProvider');
  }

  // settings.ini — explicit asset > lazy provider > generated from options.
  let settingsBytes = toUint8(assets?.settings);
  if (!settingsBytes && config.settingsProvider) {
    settingsBytes = toUint8(await config.settingsProvider());
  }
  if (settingsBytes) {
    Module.FS.writeFile(settingsPath, settingsBytes);
  } else if (!fileExists(Module, settingsPath)) {
    Module.FS.writeFile(settingsPath, new TextEncoder().encode(buildSettingsIni(options)));
  }

  Module.FS.chdir(workDir);

  const setPaused = (paused: boolean) => {
    if (typeof Module.web_devmenu_set_paused === 'function') Module.web_devmenu_set_paused(paused);
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

  // No 'UsingCWD' argv — that's a v4-ism; v5U's main() doesn't parse it. The
  // engine resolves Settings.ini/dataFile relative to the FS CWD set above.
  Module.callMain([]);
  emit({ type: 'ready' });

  return {
    start() {},
    pause() { setPaused(true); },
    resume() { setPaused(false); },
    reset() {
      throw new Error('rsdkv5: reset() is not supported — destroy() and load() again');
    },
    setInput(preset) {
      if (typeof window !== 'undefined') {
        (window as any).__gamepadKeyMap = preset ?? manifest.input;
      }
    },
    destroy() {
      try { Module.pauseMainLoop?.(); } catch { /* noop */ }
      try { setPaused(true); } catch { /* noop */ }
    },
    devMenu,
    persistent,
    storageNamespace,
    purgeStorage() {
      return {
        data: deleteFileIfExists(Module, dataPath),
        settings: deleteFileIfExists(Module, settingsPath),
      };
    },
  };
}

export default { manifest, load };

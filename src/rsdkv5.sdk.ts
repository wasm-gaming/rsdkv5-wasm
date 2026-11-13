/**
 * The engine package's entry point: an `EngineSDK` for RSDKv5 (Sonic Mania).
 *
 * ```js
 * import Rsdkv5SDK from '@wasm-gaming/rsdkv5-wasm';
 *
 * const play = await new Rsdkv5SDK()
 *   .assets({ data: () => readDataRsdk() })    // bytes, or a thunk
 *   .storage({ namespace: 'sonic-mania' })        // → OPFS rsdkv5/sonic-mania/
 *   .mount(document.querySelector('#stage'))
 *   .start();
 *
 * play.pause('menu'); play.resume('menu');
 * play.devMenu.getStageList();               // the host draws its own stage select
 * await play.destroy();                      // save flushed, loop stopped, audio closed
 * ```
 *
 * One game-agnostic `rsdkv5.wasm`: `Data.rsdk` is written into the filesystem at
 * runtime, never baked in. The working dir `/data/rsdkv5/<namespace>` is in memory;
 * Sonic Mania writes its user files there (`SaveData.bin`, `TimeAttackDB.bin`,
 * `ReplayDB.bin`, `Replay_*.bin`). The SDK seeds them from OPFS `rsdkv5/<namespace>/`
 * before boot and mirrors back whatever changed (every 10 s, on pause, on page hide
 * and on destroy).
 */
import {
  EnginePlayBase,
  EngineSDKBase,
  EventEmitter,
  type EngineInit,
  type EngineSDKConstructor,
  type EventsOf,
  type PayloadKind,
} from '@wasm-gaming/engine-specs';
import {
  RSDKV5_SPEC,
  RSDKV5_VIDEO,
  type Rsdkv5Asset,
  type Rsdkv5Config,
  type Rsdkv5Options,
  type Rsdkv5Payloads,
} from './rsdkv5.options.js';

export type {
  Rsdkv5Asset,
  Rsdkv5Assets,
  Rsdkv5Config,
  Rsdkv5Events,
  Rsdkv5Options,
  Rsdkv5Payloads,
  Rsdkv5Storage,
} from './rsdkv5.options.js';
export { RSDKV5_SPEC, RSDKV5_VIDEO } from './rsdkv5.options.js';

const ENGINE_ID = 'rsdkv5';
const DEFAULT_STORAGE_NAMESPACE = 'default';
const WORK_ROOT = '/data';
/** Inputs the SDK writes itself; everything else in the working dir is the game's. */
const NOT_SAVES = new Set(['Data.rsdk', 'Settings.ini', 'log.txt']);
const SAVE_INTERVAL_MS = 10_000;

/** The Emscripten module this build produces (`createRSDKv5` from rsdkv5.js). */
interface Rsdkv5Module {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isFile(mode: number): boolean;
    chdir(path: string): void;
  };
  callMain(args: string[]): void;
  pauseMainLoop?: () => void;
  resumeMainLoop?: () => void;
  web_devmenu_get_stage_list?: () => string;
  web_devmenu_load_stage?: (category: number, stage: number) => void;
  web_devmenu_set_paused?: (paused: boolean) => void;
  _web_mania_save_status?: () => number;
  _web_mania_start_slot?: (slot: number, character: number) => number;
  _web_mania_characters?: () => number;
  SDL2?: { audioContext?: AudioContext };
}

type Rsdkv5Factory = (overrides: Record<string, unknown>) => Promise<Rsdkv5Module>;

/** The launcher's handle on RSDKv5's stage list, for drawing its own dev menu. */
export interface RsdkDevMenuBridge {
  getStageList(): Array<{ name: string; stages: Array<{ name: string }> }>;
  loadStage(category: number, stage: number): void;
}

/** Mania's characters, by the `characterID` its save slots store. */
export const MANIA_CHARACTERS = ['Sonic & Tails', 'Sonic', 'Tails', 'Knuckles', 'Mighty', 'Ray'] as const;

/** Mania Mode's zones, by the `zoneID` its save slots store. */
export const MANIA_ZONES = [
  'Green Hill', 'Chemical Plant', 'Studiopolis', 'Flying Battery', 'Press Garden', 'Stardust Speedway',
  'Hydrocity', 'Mirage Saloon', 'Oil Ocean', 'Lava Reef', 'Metallic Madness', 'Titanic Monarch', 'Egg Reverie',
] as const;

/** One Mania Mode save slot, as `SaveData.bin` has it. */
export interface ManiaSaveSlot {
  /** 0-7, the slot Mania numbers 1-8. */
  slot: number;
  state: 'empty' | 'progress' | 'complete';
  /** Index into {@link MANIA_CHARACTERS}. */
  character: number;
  /** Index into {@link MANIA_ZONES}; meaningful while in progress. */
  zone: number;
  zoneName: string;
  lives: number;
  score: number;
  /** How many of the seven Chaos Emeralds (the save keeps a bit mask). */
  emeralds: number;
  continues: number;
}

/** Mania Plus's eight regular save slots in `SaveData.bin` (Encore slots are elsewhere). */
export const MANIA_SAVE_SLOTS = 8;
const SLOT_BYTES = 0x400;
const SLOT_FIELDS = 0x58; // SaveRAM: the entity header Mania keeps before the fields

/**
 * Mania Mode's save slots from `SaveData.bin` (`globals->saveRAM`, int32 LE): slot `s`
 * is the 0x400-byte block at `0x400 * s`, fields from +0x58. A missing or short file
 * reads as empty slots.
 */
export function parseManiaSaves(bytes: Uint8Array | null): ManiaSaveSlot[] {
  const view = bytes ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  return Array.from({ length: MANIA_SAVE_SLOTS }, (_, slot) => {
    const base = slot * SLOT_BYTES + SLOT_FIELDS;
    const field = (i: number): number => (view && base + i * 4 + 4 <= view.byteLength ? view.getInt32(base + i * 4, true) : 0);
    const state = field(0) === 1 ? 'progress' : field(0) === 2 ? 'complete' : 'empty';
    const character = Math.max(0, Math.min(MANIA_CHARACTERS.length - 1, field(1)));
    const zone = field(2);
    let emeralds = 0;
    for (let mask = field(6) & 0x7f; mask; mask >>= 1) emeralds += mask & 1;
    return {
      slot,
      state,
      character: state === 'empty' ? 0 : character,
      zone: state === 'empty' ? 0 : zone,
      zoneName: state === 'complete' ? 'Complete' : state === 'empty' ? '' : (MANIA_ZONES[zone] ?? 'Unknown zone'),
      lives: state === 'empty' ? 3 : field(3),
      score: state === 'empty' ? 0 : field(4),
      emeralds: state === 'empty' ? 0 : emeralds,
      continues: state === 'empty' ? 0 : field(7),
    };
  });
}

/** Mania Mode's save slots, read and started the way Mania's own save select does. */
export interface ManiaSaves {
  /** True when this build has the bridge (older wasm builds don't). */
  readonly available: boolean;
  /** How many characters a new game can pick: 6 with Plus (Mighty, Ray), else 4. */
  readonly characters: number;
  /** The eight slots, from the save file as it is now. */
  list(): ManiaSaveSlot[];
  /**
   * Resolves true once Mania has its save file loaded (it asks Mania to load it), false
   * if that failed or took longer than `timeoutMs`.
   */
  ready(timeoutMs?: number): Promise<boolean>;
  /**
   * Start a slot: an empty one is a new game with `character` (an index into
   * {@link MANIA_CHARACTERS}), a saved one continues with its own. Mania writes the
   * save and loads the stage; the pause is lifted. False when the save isn't ready.
   */
  start(slot: number, character?: number): boolean;
}

/**
 * Where an engine keeps one namespace: `<engineId>/<namespace>`, relative to the OPFS
 * root. Identical in every wasm-gaming engine, written to move verbatim into
 * engine-specs: segments cleaned, `.` and `..` dropped, anything outside
 * `[A-Za-z0-9._-]` → `_`, nothing usable → `default`; a leading `<engineId>/` is
 * stripped once.
 */
export function storagePath(
  engineId: string,
  namespace: unknown,
): { namespace: string; path: string; prefixed: boolean } {
  const segments =
    typeof namespace === 'string'
      ? namespace
          .split('/')
          .map((segment) => segment.trim())
          .filter((segment) => segment && segment !== '.' && segment !== '..')
          .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
      : [];
  const prefixed = segments.length > 1 && segments[0] === engineId;
  if (prefixed) segments.shift();
  const cleaned = segments.join('/') || DEFAULT_STORAGE_NAMESPACE;
  return { namespace: cleaned, path: `${engineId}/${cleaned}`, prefixed };
}

/**
 * Serialise the engine config into RSDKv5U's `Settings.ini` (capital S — the engine
 * opens exactly that name, and the Emscripten FS is case-sensitive). The v5 dialect:
 * lowercase keys, 0/1 booleans, `dataFile=` naming the pack relative to the working dir.
 */
export function buildSettingsIni(config: Rsdkv5Config): string {
  const b = (v: boolean | undefined) => (v ? '1' : '0');
  return [
    '[Game]',
    'dataFile=Data.rsdk',
    `devMenu=${b(config.devMenu)}`,
    `language=${(config.language ?? 0) | 0}`,
    `region=${(config.region ?? -1) | 0}`,
    '',
    '[Video]',
    'windowed=1',
    'border=1',
    'exclusiveFS=0',
    `vsync=${b(config.vsync ?? true)}`,
    'tripleBuffering=0',
    `pixWidth=${RSDKV5_VIDEO.width}`,
    `winWidth=${RSDKV5_VIDEO.width}`,
    `winHeight=${RSDKV5_VIDEO.height}`,
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

async function opfsDir(path: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of path.split('/').filter(Boolean)) {
      dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
  } catch {
    return null;
  }
}

async function resolveAsset(asset: Rsdkv5Asset | undefined): Promise<Uint8Array | null> {
  const value = typeof asset === 'function' ? await asset() : asset;
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('rsdkv5: an asset must be a Uint8Array, an ArrayBuffer or a thunk returning one');
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function mkdirp(Module: Rsdkv5Module, path: string): void {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    try {
      Module.FS.mkdir(current);
    } catch {
      /* exists */
    }
  }
}

/** The live engine: one booted RSDKv5 and its session. */
export class Rsdkv5Play extends EnginePlayBase<Rsdkv5Payloads> {
  #module: Rsdkv5Module | null = null;
  #destroyed = false;
  #pauseOwner: string | null = null;
  #muted = false;

  #canvas: HTMLCanvasElement | null = null;
  #ownsCanvas = false;
  #box: HTMLElement | null = null;
  #boxObserver: ResizeObserver | null = null;

  #namespace = DEFAULT_STORAGE_NAMESPACE;
  #storagePath = `${ENGINE_ID}/${DEFAULT_STORAGE_NAMESPACE}`;
  #workDir = `${WORK_ROOT}/${ENGINE_ID}/${DEFAULT_STORAGE_NAMESPACE}`;
  #persist = true;
  #saveTimer: ReturnType<typeof setInterval> | null = null;
  #lastSaved = new Map<string, Uint8Array>();
  #flushing: Promise<void> | null = null;
  #onHidden = (): void => {
    if (document.visibilityState === 'hidden') void this.flushSaves();
  };

  constructor(init?: EngineInit<Rsdkv5Payloads>, events?: EventEmitter<EventsOf<Rsdkv5Payloads>>) {
    super(RSDKV5_SPEC, init, events);
  }

  get namespace(): string {
    return this.#namespace;
  }

  /** Where this session's files live, relative to the OPFS root: `rsdkv5/<namespace>`. */
  get storagePath(): string {
    return this.#storagePath;
  }

  get pausedBy(): string | null {
    return this.#pauseOwner;
  }

  /** Mania Mode's save slots — see {@link ManiaSaves}. */
  get saves(): ManiaSaves {
    const Module = this.#module;
    const workDir = this.#workDir;
    const available = !!Module?._web_mania_save_status && !!Module._web_mania_start_slot;
    return {
      available,
      characters: available && Module?._web_mania_characters ? Module._web_mania_characters() : 4,
      list: () => {
        let bytes: Uint8Array | null = null;
        try {
          bytes = Module ? new Uint8Array(Module.FS.readFile(`${workDir}/SaveData.bin`)) : null;
        } catch {
          bytes = null; // no save file yet: eight empty slots
        }
        return parseManiaSaves(bytes);
      },
      ready: async (timeoutMs = 5000) => {
        if (!available || !Module) return false;
        const deadline = performance.now() + timeoutMs;
        for (;;) {
          const status = Module._web_mania_save_status!();
          if (status === 200) return true;
          if ((status !== 0 && status !== 100) || performance.now() > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
      start: (slot, character = 0) => {
        if (!available || !Module) return false;
        if (!Module._web_mania_start_slot!(slot | 0, character | 0)) return false;
        // Whatever drove this is done with the engine: hand it back running.
        if (this.#pauseOwner) this.resume(this.#pauseOwner);
        return true;
      },
    };
  }

  /** RSDKv5's stage list, for a host that draws its own stage select. */
  get devMenu(): RsdkDevMenuBridge {
    const Module = (): Rsdkv5Module | null => this.#module;
    return {
      getStageList() {
        try {
          return JSON.parse(Module()?.web_devmenu_get_stage_list?.() ?? '[]');
        } catch {
          return [];
        }
      },
      loadStage(category: number, stage: number) {
        Module()?.web_devmenu_load_stage?.(category | 0, stage | 0);
      },
    };
  }

  /**
   * Freeze the game and its sound. The first caller owns the pause; only that
   * owner's {@link resume} lifts it. The save is flushed.
   */
  pause(owner = 'host'): void {
    const Module = this.#module;
    if (!Module || this.#pauseOwner) return;
    this.#pauseOwner = owner;
    Module.web_devmenu_set_paused?.(true);
    // This build has no native pause hook (web_devmenu_* are not compiled in), so the
    // game is frozen by stopping emscripten's main loop: no frame runs until resume().
    Module.pauseMainLoop?.();
    void Module.SDL2?.audioContext?.suspend();
    void this.flushSaves();
    this.emit('pause', { owner });
  }

  resume(owner = 'host'): void {
    const Module = this.#module;
    if (!Module || this.#pauseOwner !== owner) return;
    this.#pauseOwner = null;
    if (!this.#muted) void Module.SDL2?.audioContext?.resume();
    Module.web_devmenu_set_paused?.(false);
    Module.resumeMainLoop?.();
    this.emit('resume', { owner });
  }

  /**
   * Silence the game without stopping it (the frames keep running). A host uses it to
   * let Mania get somewhere — load its save file — behind its own screen. Independent
   * of {@link pause}: a paused game stays silent either way.
   */
  mute(muted = true): void {
    this.#muted = muted;
    const context = this.#module?.SDL2?.audioContext;
    if (muted) void context?.suspend();
    else if (!this.#pauseOwner) void context?.resume();
  }

  get muted(): boolean {
    return this.#muted;
  }

  /** Copy the game's changed user files to OPFS `rsdkv5/<namespace>/`; emits `saves`. */
  flushSaves(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = null;
    });
    return this.#flushing;
  }

  // ---- Contract hooks ----

  protected override mounted(target: HTMLElement): void {
    if (target instanceof HTMLCanvasElement) {
      this.#canvas = target;
      this.#ownsCanvas = false;
      this.#box = target.parentElement;
    } else {
      this.#canvas = document.createElement('canvas');
      this.#ownsCanvas = true;
      this.#box = target;
      target.appendChild(this.#canvas);
    }
    // Emscripten's SDL2 port finds its window with querySelector('#canvas').
    this.#canvas.id = 'canvas';
    this.#canvas.tabIndex = 0;
    this.#canvas.style.display = 'block';
    this.#canvas.style.imageRendering = 'pixelated';
    this.#canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    if (this.#ownsCanvas && this.#box) {
      this.#boxObserver?.disconnect();
      this.#boxObserver = new ResizeObserver(() => this.#fit());
      this.#boxObserver.observe(this.#box);
    }
  }

  protected override async open(_options: Rsdkv5Options): Promise<void> {
    if (this.#destroyed || this.#module) {
      // RSDKv5 cannot restart in process: main() runs once and owns the loop.
      throw new Error('rsdkv5: the engine cannot be restarted in process — destroy() and start a new page (or iframe)');
    }
    await this.#boot();
  }

  protected override patched(_kind: PayloadKind, _patch: object): void {
    // Nothing in RSDKV5_SPEC is live: Settings.ini is read once, at boot.
  }

  protected override async close(): Promise<void> {
    if (this.#saveTimer) clearInterval(this.#saveTimer);
    this.#saveTimer = null;
    document.removeEventListener('visibilitychange', this.#onHidden);
    window.removeEventListener('pagehide', this.#onHidden);
    const Module = this.#module;
    if (Module) {
      await this.flushSaves();
      try {
        Module.web_devmenu_set_paused?.(true);
        Module.pauseMainLoop?.();
      } catch {
        /* already stopped */
      }
      try {
        await Module.SDL2?.audioContext?.close();
      } catch {
        /* already closed */
      }
    }
    this.#boxObserver?.disconnect();
    this.#boxObserver = null;
    if (this.#ownsCanvas) this.#canvas?.remove();
    this.#canvas = null;
    this.#module = null;
    this.#pauseOwner = null;
    this.#destroyed = true;
  }

  // ---- Boot ----

  async #boot(): Promise<void> {
    const config = await this.#values<Rsdkv5Config>('config');
    const assets = await this.#values<{ data?: Rsdkv5Asset; settings?: Rsdkv5Asset }>('assets');
    const storage = await this.#values<{ namespace?: string; persist?: 'opfs' | null }>('storage');
    if (!this.#canvas) throw new Error('rsdkv5: mount() an element (or a canvas) before start()');

    const data = await resolveAsset(assets.data);
    if (!data) throw new Error('rsdkv5: no Data.rsdk — hand one over as assets.data (bytes or a thunk)');
    const settings = await resolveAsset(assets.settings);

    const resolved = storagePath(ENGINE_ID, storage.namespace);
    if (resolved.prefixed) {
      console.warn(`[rsdkv5] storage.namespace no longer needs the "${ENGINE_ID}/" prefix. Pass "${resolved.namespace}".`);
    }
    this.#namespace = resolved.namespace;
    this.#storagePath = resolved.path;
    this.#workDir = `${WORK_ROOT}/${resolved.path}`;
    this.#persist = storage.persist !== null;

    const jsUrl = config.jsUrl ?? new URL('./rsdkv5.js', import.meta.url).href;
    const wasmUrl = config.wasmUrl ?? new URL('./rsdkv5.wasm', import.meta.url).href;
    const { default: createRSDKv5 } = (await import(/* @vite-ignore */ jsUrl)) as { default: Rsdkv5Factory };

    let failed: ((error: Error) => void) | null = null;
    const Module = await createRSDKv5({
      canvas: this.#canvas,
      noInitialRun: true,
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : new URL(path, jsUrl).href),
      print: (text: string) => console.log('[rsdkv5]', text),
      printErr: (text: string) => console.warn('[rsdkv5]', text),
      onAbort: (what: unknown) => failed?.(new Error(`rsdkv5: aborted — ${String(what)}`)),
    });
    this.#module = Module;
    failed = (error) => this.emit('error', error);

    mkdirp(Module, this.#workDir);
    Module.FS.writeFile(`${this.#workDir}/Data.rsdk`, data);
    Module.FS.writeFile(
      `${this.#workDir}/Settings.ini`,
      settings ?? new TextEncoder().encode(buildSettingsIni(config)),
    );
    if (this.#persist) await this.#restoreSave();

    Module.FS.chdir(this.#workDir);
    // RSDKv5U resolves Settings.ini and dataFile relative to the CWD set above.
    Module.callMain([]);

    if (this.#persist) {
      this.#saveTimer = setInterval(() => void this.flushSaves(), SAVE_INTERVAL_MS);
      document.addEventListener('visibilitychange', this.#onHidden);
      window.addEventListener('pagehide', this.#onHidden);
    }
    this.#fit();
  }

  async #values<T>(kind: 'config' | 'assets' | 'storage'): Promise<T> {
    const described = (await this[kind]()) as Record<string, { value: unknown }>;
    const out: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(described)) out[key] = property.value;
    return out as T;
  }

  // ---- Save mirror ----

  async #restoreSave(): Promise<void> {
    const dir = await opfsDir(this.#storagePath, false);
    if (!dir || !this.#module) return;
    const iterable = dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> };
    for await (const [name, handle] of iterable.entries()) {
      if (handle.kind !== 'file' || NOT_SAVES.has(name)) continue;
      const bytes = new Uint8Array(await (await (handle as FileSystemFileHandle).getFile()).arrayBuffer());
      this.#module.FS.writeFile(`${this.#workDir}/${name}`, bytes);
      this.#lastSaved.set(name, bytes);
    }
  }

  async #flush(): Promise<void> {
    const Module = this.#module;
    if (!Module || !this.#persist) return;
    const changed: Array<[string, Uint8Array<ArrayBuffer>]> = [];
    let names: string[];
    try {
      names = Module.FS.readdir(this.#workDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.' || name === '..' || NOT_SAVES.has(name)) continue;
      const path = `${this.#workDir}/${name}`;
      if (!Module.FS.isFile(Module.FS.stat(path).mode)) continue;
      const bytes = new Uint8Array(Module.FS.readFile(path));
      if (!sameBytes(this.#lastSaved.get(name) ?? null, bytes)) changed.push([name, bytes]);
    }
    if (changed.length === 0) return;
    const dir = await opfsDir(this.#storagePath, true);
    if (!dir) return;
    const written: string[] = [];
    for (const [name, bytes] of changed) {
      try {
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(bytes);
        await writable.close();
        this.#lastSaved.set(name, bytes);
        written.push(name);
      } catch (e) {
        console.warn(`[rsdkv5] could not persist ${name}`, e);
      }
    }
    if (written.length) this.emit('saves', { files: written });
  }

  // ---- Picture ----

  #fit(): void {
    const canvas = this.#canvas;
    const box = this.#box;
    if (!canvas || !box || !this.#ownsCanvas) return;
    const { width, height } = box.getBoundingClientRect();
    if (!width || !height) return;
    const scale = Math.min(width / RSDKV5_VIDEO.width, height / RSDKV5_VIDEO.height);
    canvas.style.width = `${Math.floor(RSDKV5_VIDEO.width * scale)}px`;
    canvas.style.height = `${Math.floor(RSDKV5_VIDEO.height * scale)}px`;
  }
}

/** The factory a host constructs: static identity, the configuration chain, `start()`. */
export class Rsdkv5SDK extends EngineSDKBase<Rsdkv5Payloads> {
  static readonly id = ENGINE_ID;
  /** Kept in step with package.json by `node scripts/sync-version.mjs`. */
  static readonly version = '0.1.2';
  static readonly name = 'Retro Software Development Kit v3';
  static readonly description =
    'RSDKv5U (Sonic Mania decompilation) compiled to WebAssembly. Ships none of the game: the player provides Data.rsdk, and it never leaves their browser.';

  protected override createPlay(
    init: EngineInit<Rsdkv5Payloads>,
    events: EventEmitter<EventsOf<Rsdkv5Payloads>>,
  ): Rsdkv5Play {
    return new Rsdkv5Play(init, events);
  }
}

/** CI's conformance line: if this class stops satisfying the contract, `make test` fails. */
export const RSDKV5_ENGINE: EngineSDKConstructor<Rsdkv5Payloads> = Rsdkv5SDK;

export default Rsdkv5SDK;

/**
 * What RSDKv5 accepts, as types and as data.
 *
 * The four payloads of the wasm-gaming engine contract, closed for this engine, and
 * {@link RSDKV5_SPEC} — the same thing as data the contract's base class reads:
 * every default lives there and nowhere else.
 */
import type { EnginePayloads, EngineSpec } from '@wasm-gaming/engine-specs';

/** Bytes, or a thunk that produces them only when the engine actually needs them. */
export type Rsdkv5Asset =
  | Uint8Array
  | ArrayBuffer
  | null
  | (() => Uint8Array | ArrayBuffer | null | Promise<Uint8Array | ArrayBuffer | null>);

/** The engine, written into the generated `Settings.ini`. Fixed for the life of the wasm. */
export interface Rsdkv5Config {
  /** Sonic Mania's native dev menu. A host draws its own from `play.devMenu`. */
  devMenu?: boolean;
  vsync?: boolean;
  /** RSDKv5 language index (0 = English). */
  language?: number;
  /** RSDKv5 region (-1 = auto). */
  region?: number;
  /** Emscripten glue URL. Defaults to `./rsdkv5.js` next to the SDK. */
  jsUrl?: string;
  /** WASM URL. Defaults to `./rsdkv5.wasm` next to the SDK. */
  wasmUrl?: string;
}

/** The session. Nothing per-session yet. */
export type Rsdkv5Options = Record<string, never>;

export interface Rsdkv5Assets {
  /** The game's `Data.rsdk` (Sonic Mania). Required to start. */
  data?: Rsdkv5Asset;
  /** A ready-made `Settings.ini`; omitted, one is generated from `config`. */
  settings?: Rsdkv5Asset;
}

/** Where this engine's files live, and whether they outlive the page. */
export interface Rsdkv5Storage {
  /**
   * Per-game folder, relative to the engine's own: files land in `rsdkv5/<namespace>/`
   * (WASMFS `/data/rsdkv5/<namespace>`, and the OPFS folder the save is mirrored to).
   * Segments are cleaned (`.`/`..` dropped, odd characters → `_`); a leading
   * `rsdkv5/` is stripped once. `play.storagePath` gives the result.
   *
   * @defaultValue `"default"`
   */
  namespace?: string;
  /** `null` keeps nothing; otherwise the game's user files are mirrored to OPFS. */
  persist?: 'opfs' | null;
}

export interface Rsdkv5Events {
  /** Save files changed and were written to `rsdkv5/<namespace>/`. */
  saves: { files: string[] };
}

export interface Rsdkv5Payloads extends EnginePayloads {
  config: Rsdkv5Config;
  options: Rsdkv5Options;
  assets: Rsdkv5Assets;
  storage: Rsdkv5Storage;
  events: Rsdkv5Events;
}

/** The native picture, which the SDK scales to fit its mount. */
export const RSDKV5_VIDEO = { width: 424, height: 240, aspect: '16:9' } as const;

export const RSDKV5_SPEC: EngineSpec<Rsdkv5Payloads> = {
  config: {
    devMenu: {
      default: false,
      live: false,
      description: "Sonic Mania's native dev menu; keep it off and draw your own from play.devMenu.",
    },
    vsync: { default: true, live: false, description: 'VSync in the generated Settings.ini.' },
    language: { default: 0, live: false, description: 'RSDKv5 language index (0 = English).' },
    region: { default: -1, live: false, description: 'RSDKv5 region (-1 = auto).' },
    jsUrl: { live: false, description: 'Emscripten glue URL. Defaults to ./rsdkv5.js.' },
    wasmUrl: { live: false, description: 'WASM URL. Defaults to ./rsdkv5.wasm.' },
  },
  options: {},
  assets: {
    data: {
      allowedTypes: ['.rsdk'],
      live: false,
      description: 'The RSDKv5 game data pack (Sonic Mania). Required to start.',
    },
    settings: {
      allowedTypes: ['.ini'],
      live: false,
      description: 'A ready-made Settings.ini. Omitted, one is generated from config.',
    },
  },
  storage: {
    namespace: {
      default: 'default',
      live: false,
      description: "Folder for this game's saves, inside the engine's own rsdkv5/ folder (OPFS rsdkv5/<namespace>/).",
    },
    persist: {
      enum: ['opfs', null],
      live: false,
      description: "null keeps nothing; otherwise the game's user files are mirrored to OPFS.",
    },
  },
};

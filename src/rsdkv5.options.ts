// Engine-specific options for RSDKv5U (Sonic Mania).

// This is the authoritative description of what `EngineConfig.options` accepts
// for this engine. It provides both:
//   - `Rsdkv5Options`         — the compile-time type (for TS hosts/launchers)
//   - `RSDKV5_OPTIONS_SCHEMA` — the JSON Schema mirrored into manifest.json's
//                               `options` (for runtime host UI + validation)
//   - `DEFAULT_RSDKV5_OPTIONS` — defaults the SDK falls back to.
//
// APPROACH A (static + preload): Settings.ini is baked into rsdkv5.data at
// BUILD time (scripts/build.sh writes it), so these options describe build-time
// configuration — the SDK does not serialize them at runtime.

import type { JSONSchema } from '@wasm-gaming/engine-specs';

export interface Rsdkv5Options {
  /**
   * Sonic Mania's native dev menu. Kept off by default: the launcher owns its
   * own overlay, and leaving this on can hijack boot flow.
   */
  devMenu?: boolean;
  /** Enables the debug hooks exposed by the web build. */
  engineDebugMode?: boolean;
  /** VSync the engine's SDL window. */
  vsync?: boolean;
  /** Language numeric value used by the build's settings.ini. */
  language?: number;
  /** Region numeric value used by the build's settings.ini. */
  region?: number;
}

export const DEFAULT_RSDKV5_OPTIONS: Required<Rsdkv5Options> = {
  devMenu: false,
  engineDebugMode: true,
  vsync: true,
  language: 0,
  region: -1,
};

export const RSDKV5_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    devMenu: {
      type: 'boolean',
      default: false,
      description:
        "Sonic Mania's native dev menu. The launcher provides its own overlay, so keep this off.",
    },
    engineDebugMode: {
      type: 'boolean',
      default: true,
      description: 'Enables the web debug hooks.',
    },
    vsync: { type: 'boolean', default: true },
    language: { type: 'integer', default: 0, minimum: 0 },
    region: { type: 'integer', default: -1 },
  },
};

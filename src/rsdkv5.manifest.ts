// The rsdkv5 EngineManifest — typed against the contract, so a drift from
// @wasm-gaming/engine-specs is a compile error here. `make build-manifest`
// serializes this to dist/manifest.json (the artifact CI attaches to a Release).

// APPROACH A (static + preload): Sonic Mania is compiled into the engine and
// Data.rsdk/Settings.ini are baked into rsdkv5.data at build time. There are no
// runtime-mounted assets, and the options schema is applied at BUILD time
// (scripts/build.sh writes Settings.ini), not by the SDK.

import type { EngineManifest } from '@wasm-gaming/engine-specs';
import { RSDKV5_OPTIONS_SCHEMA } from './rsdkv5.options.js';

export const manifest: EngineManifest = {
  id: 'rsdkv5',
  version: '0.1.0',
  name: 'Retro Software Development Kit v5',
  artifacts: {
    // Relative to the manifest (dist/manifest.json); the engine files live in
    // the dist/rsdkv5/ subfolder. NOTE: `data` (the --preload-file package)
    // contains the proprietary game data — it is produced by running build.sh
    // with your own Data.rsdk and is never published to Releases/Pages.
    wasm: 'rsdkv5/rsdkv5.wasm',
    js: 'rsdkv5/rsdkv5.js',
    data: 'rsdkv5/rsdkv5.data',
  },
  // Nothing is mounted at runtime: game data ships inside `artifacts.data`.
  assets: [],
  input: 'rsdkv5',
  video: { baseWidth: 424, baseHeight: 240, aspect: '16:9' },
  options: RSDKV5_OPTIONS_SCHEMA,
  capabilities: { saveStates: false, sram: false, coreSelectable: false },
};

export default manifest;

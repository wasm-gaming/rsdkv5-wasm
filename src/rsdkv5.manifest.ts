// The rsdkv5 EngineManifest — typed against the contract, so a drift from
// @wasm-gaming/engine-specs is a compile error here. `npm run build:manifest`
// serializes this to dist/manifest.json (the artifact CI attaches to a Release).

import type { EngineManifest } from '@wasm-gaming/engine-specs';
import { RSDKV5_OPTIONS_SCHEMA } from './rsdkv5.options.js';

export const manifest: EngineManifest = {
  id: 'rsdkv5',
  version: '0.1.0',
  name: 'Retro Software Development Kit v5',
  artifacts: {
    // Relative to the manifest (dist/manifest.json); the engine files live in
    // the dist/rsdkv5/ subfolder.
    wasm: 'rsdkv5/rsdkv5.wasm',
    js: 'rsdkv5/rsdkv5.js',
  },
  assets: [
    {
      key: 'data',
      // Lives under the OPFS-backed (persistent) working dir; the engine reads it
      // via CWD.
      mountPath: '/data/Data.rsdk',
      required: true,
      accept: ['.rsdk'],
      description:
        'RSDKv5 game data pack. Sonic Mania uses this at runtime to select content.',
    },
    {
      key: 'settings',
      mountPath: '/data/Settings.ini',
      required: false,
      accept: ['.ini'],
      description:
        'Engine settings. Omitted → the SDK generates one from config.options.',
    },
  ],
  input: 'rsdkv5',
  video: { baseWidth: 424, baseHeight: 240, aspect: '16:9' },
  options: RSDKV5_OPTIONS_SCHEMA,
  capabilities: { saveStates: false, sram: false, coreSelectable: false },
};

export default manifest;

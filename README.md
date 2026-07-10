# @wasm-gaming/rsdkv5-wasm

RSDKv5U (Sonic Mania) compiled to WebAssembly, with a JS SDK conforming to the wasm-gaming engine contract.

## Package layout
- `src/rsdkv5.manifest.ts` defines the engine manifest.
- `src/rsdkv5.options.ts` defines the host-facing options schema.
- `src/rsdkv5.sdk.ts` loads the engine, mounts `Data.rsdk`, and exposes the host contract.
- `src/demo/` contains a standalone harness for local testing.

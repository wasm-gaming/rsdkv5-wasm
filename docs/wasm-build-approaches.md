# RSDKv5 WASM build — approaches (index)

`make build` currently fails on purpose: `build-wasm` → `scripts/build.sh` is a
stub (`exit 1`) because the WASM source was never wired up. Two concrete ways to
wire it up are specified, one per document, each meant to be implemented on its
own branch:

- **[Shared core](wasm-build-shared-core.md)** — background (why v5 ≠ v3/v4),
  pinned sources, vendored libogg/libtheora, the four mandatory engine patches,
  CMake invocation, memory flags, verification. Identical on both branches; read
  it first.
- **[Approach A — static + preload](wasm-build-approach-a-static-preload.md)** —
  mirror the proven recipe (`.peers/build-rsdkv5-docker.sh`): Sonic Mania static,
  data baked in via `--preload-file`, plain `[FS,callMain]` module. Lowest risk;
  costs a rewrite of SDK/manifest/demo and adds a `.data` artifact.
- **[Approach B — keep the SDK contract](wasm-build-approach-b-sdk-contract.md)** —
  same proven core, but emit the `createRSDKv5` ES6 factory with `INVOKE_RUN=0`
  and mount `Data.rsdk` at runtime, preserving `rsdkv5.sdk.ts` / manifest / demo.
  Riskier: five open items to verify with a real build.

## Recommendation

Branch **A** first as the known-good baseline (get *something* that runs), then
branch **B** to restore this repo's SDK ergonomics on top of that proven core. The
risky, novel work is entirely in B's open items; A de-risks everything else.

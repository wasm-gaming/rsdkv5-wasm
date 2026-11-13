# @wasm-gaming/rsdkv5-wasm

RSDKv5U (Retro Software Development Kit v5 Ultimate, the Sonic Mania decompilation) compiled to
WebAssembly, wrapped in a self-contained SDK that implements the
[wasm-gaming engine contract](https://github.com/wasm-gaming/engine-specs) 1.0.

The engine bakes no game data: the host hands over `Data.rsdk` at runtime, so one `rsdkv5.wasm`
serves any install.

## Install

```bash
npm install @wasm-gaming/rsdkv5-wasm
```

The SDK carries the contract's runtime beside it (`dist/rsdkv5/engine-specs.js`) and imports it
relatively: it loads from any static server, with no bundler and no import map. The wasm and its
glue are built in CI and shipped in the GitHub Release (`rsdkv5.tar.gz`, layout `rsdkv5/rsdkv5/…`).

## Use

```js
import Rsdkv5SDK from './rsdkv5/rsdkv5.sdk.js';

const play = await new Rsdkv5SDK({ config: { region: -1 } })      // auto region
  .assets({ data: () => readDataRsdk() })      // bytes, or a thunk
  .storage({ namespace: 'sonic-mania' })          // → OPFS rsdkv5/sonic-mania/
  .on('saves', ({ detail }) => console.log('saved', detail.files))
  .mount(document.querySelector('#stage'))
  .start();

play.pause('menu');  play.resume('menu');      // owner-aware; sound stops too
play.devMenu.getStageList();                   // draw your own stage select…
play.devMenu.loadStage(0, 2);                  // …and warp
await play.destroy();                          // save flushed, loop stopped, audio closed
```

| payload | keys |
| --- | --- |
| `config` | `devMenu`, `vsync`, `language`, `region` (-1 auto) (→ generated `Settings.ini`), `jsUrl`, `wasmUrl` |
| `options` | — |
| `assets` | `data` (`Data.rsdk`, required), `settings` (`Settings.ini`, optional — capital S, the name RSDKv5U opens) |
| `storage` | `namespace` (default `default`), `persist` (`'opfs'` \| `null`) |

Events: the contract's `start`, `error`, `exit`, `pause`, `resume`, plus `saves`.
RSDKv5 cannot restart in process: after `destroy()`, a new session needs a new page (or iframe).

## The engine's own app

A host that would rather not draw menus mounts the app shipped next to the SDK
([engine-specs](https://github.com/wasm-gaming/engine-specs) `EngineApp`, `UX.md`):

```js
const app = await import('@wasm-gaming/rsdkv5-wasm/app'); // dist/rsdkv5/app/app.js
const handle = await app.mount(element, { game, storage, assets, input, exit });
await handle.unmount();
```

It shows a boot screen, then Sonic Mania with its own title and save select. Select + Start or
Escape opens the pause menu: *Continuar*, the game's own screens found in the stage list (title
screen, main menu, level select — only those the data has) and *Volver al lanzador* (asks first).
There is no load-game screen like rsdkv4's yet: that needs a native bridge (see `RECORD/`).

This build does not expose the stage list yet, so Mania's pause menu has only *Continuar* and
*Volver al lanzador*. `pause()` freezes the game by stopping emscripten's main loop.

## Saves live in the engine's own folder

The working dir is `/data/rsdkv5/<namespace>` (in memory), and Sonic Mania writes its user files there
(`SaveData.bin`, `TimeAttackDB.bin`, `ReplayDB.bin`, `Replay_*.bin`). The SDK seeds them from OPFS
`rsdkv5/<namespace>/` before boot and mirrors back whatever changed — every 10 s, on pause, when
the page is hidden and on `destroy()` — so saves survive reloads. `play.storagePath` gives the
folder; `storagePath(engineId, namespace)` is exported.

## Build

```bash
make build-sdk      # TypeScript → dist/rsdkv5/ (fast, no Docker)
make test           # type-check + tests against the built package
make build-wasm     # RSDKv5U → WebAssembly in emscripten/emsdk:6.0.2 (Docker)
make demo           # dist/index.html: a no-build demo (pick or drop Data.rsdk)
make preview        # serve dist/ on :8025
```

The upstream decompilation is pinned (`9dc69942`) together with its submodules, and so is the emsdk
image; see [docs/](docs/) for how the build is put together.

## Project Specs

- Contract 1.0 class (`Rsdkv5SDK` / `Rsdkv5Play`), self-contained ESM, engine-specs as the one
  dependency; conformance line `RSDKV5_ENGINE` checked by `make test`.
- Engine-owned storage `rsdkv5/<namespace>/`, mirroring every user file the game writes.
- Records of decisions in [RECORD/](RECORD/).

## Todos

- [ ] Verify with a real `Data.rsdk` (save written by the game → mirrored → restored).

## License

MIT for this wrapper. The upstream engine and the game data keep their own licenses.

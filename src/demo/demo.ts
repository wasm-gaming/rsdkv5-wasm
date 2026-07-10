// Standalone demo harness for the RSDKv5 SDK (APPROACH A: static + preload).
//
// Compiles to dist/demo.js and is loaded by dist/index.html. It consumes the SDK
// by package name, exactly as a real host would.
//
// Game data is baked into rsdkv5.data at build time, so there is nothing to
// pick or drag-and-drop here: either the sibling ./rsdkv5/rsdkv5.data exists
// (you ran `make build-wasm` with your Data.rsdk at dist/Data.rsdk) or the
// engine cannot boot at all.

import { load, type Rsdkv5Instance } from '@wasm-gaming/rsdkv5-wasm';
import type { EngineEvent } from '@wasm-gaming/engine-specs';

const status = document.getElementById('status') as HTMLParagraphElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

function showStatus(text: string): void {
  status.textContent = text;
  status.hidden = false;
}

function wireEscape(engine: Rsdkv5Instance): void {
  let paused = false;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    paused = !paused;
    paused ? engine.pause() : engine.resume();
  }, true);
}

(async () => {
  try {
    const engine = await load({
      canvas,
      assets: {}, // nothing mounted at runtime — data ships in rsdkv5.data
      onEvent: (ev: EngineEvent) => {
        console.log('[demo] engine event', ev);
        if (ev.type === 'error') {
          showStatus(
            'Engine error: ' + ev.error.message +
            ' — if rsdkv5.data failed to load, run `make build-wasm` with your ' +
            'Data.rsdk at dist/Data.rsdk (game data is never distributed).',
          );
        }
      },
    });
    (window as any).__engine = engine;
    status.hidden = true;
    wireEscape(engine);
  } catch (e) {
    console.error('[demo] boot failed', e);
    showStatus(
      'Boot failed (see console). Likely cause: dist/rsdkv5/rsdkv5.data is ' +
      'missing — run `make build-wasm` with your Data.rsdk at dist/Data.rsdk.',
    );
  }
})();

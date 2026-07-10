// Standalone demo harness for the RSDKv5 SDK.
//
// Compiles to dist/demo.js and is loaded by dist/index.html. It consumes the SDK
// by package name, exactly as a real host would.
//
// Data.rsdk resolution mirrors a real launcher:
//   1. If it's already persisted in OPFS (cross-origin isolated pages), the SDK
//      reuses it and the `dataProvider` fetch below is never called.
//   2. Otherwise the SDK calls `dataProvider`, which fetches a sibling ./Data.rsdk.
//   3. If that fetch fails, we fall back to a pick / drag-and-drop prompt.

import { load, type Rsdkv5Instance } from '@wasm-gaming/rsdkv5-wasm';
import type { EngineEvent } from '@wasm-gaming/engine-specs';

const picker = document.getElementById('picker') as HTMLDivElement;
const status = document.getElementById('status') as HTMLParagraphElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const canvas = document.getElementById('canvas') as HTMLCanvasElement;

/** Fetch an optional sibling file; returns its bytes, or null if absent. */
async function fetchOptional(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Fetch the sibling Data.rsdk; throws if it isn't served. */
async function fetchData(): Promise<Uint8Array> {
  const res = await fetch('./Data.rsdk');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let booting = false;

async function boot(source: { data?: Uint8Array }): Promise<void> {
  if (booting) return;
  booting = true;
  picker.classList.add('hidden');
  try {
    const settings = await fetchOptional('./settings.ini');
    const engine: Rsdkv5Instance = await load({
      canvas,
      assets: {
        ...(source.data ? { data: source.data } : {}),
        ...(settings ? { settings } : {}),
      },
      dataProvider: source.data ? undefined : fetchData,
      onEvent: (ev: EngineEvent) => {
        console.log('[demo] engine event', ev);
        if (ev.type === 'error') alert('Engine error: ' + ev.error.message);
      },
    });
    (window as any).__engine = engine;
    console.log('[demo] working dir persistent (OPFS):', engine.persistent);
    wireEscape(engine);
  } catch (e) {
    booting = false;
    picker.classList.remove('hidden');
    throw e;
  }
}

function wireEscape(engine: Rsdkv5Instance): void {
  let paused = false;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    paused = !paused;
    paused ? engine.pause() : engine.resume();
    if (paused) console.log('[demo] stage list:', engine.devMenu.getStageList());
  }, true);
}

async function bootFromFile(file: File): Promise<void> {
  try {
    await boot({ data: new Uint8Array(await file.arrayBuffer()) });
  } catch (e) {
    console.error('[demo] boot failed', e);
  }
}

function offerPicker(reason: string): void {
  status.textContent = reason;
  fileInput.hidden = false;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void bootFromFile(file);
  });

  const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  for (const t of ['dragenter', 'dragover'] as const) {
    window.addEventListener(t, (e) => { stop(e); picker.classList.add('dragover'); });
  }
  for (const t of ['dragleave', 'dragend'] as const) {
    window.addEventListener(t, (e) => { stop(e); picker.classList.remove('dragover'); });
  }
  window.addEventListener('drop', (e) => {
    stop(e);
    picker.classList.remove('dragover');
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void bootFromFile(file);
  });
}

(async () => {
  try {
    await boot({});
  } catch (e) {
    console.warn('[demo] no persisted/served Data.rsdk — showing picker', e);
    offerPicker('No Data.rsdk found — pick one, or drag & drop it anywhere:');
  }
})();

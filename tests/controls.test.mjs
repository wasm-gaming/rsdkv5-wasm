// Remapping in front of the engine's SDL: keys replayed as its defaults, freed defaults
// swallowed, pad buttons reordered. Against the built package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RSDKV5_CONTROLS, RSDKV5_SPEC, controlTables, remapPad } from '../dist/rsdkv5/rsdkv5.sdk.js';

const pad = (pressed) => ({
  id: 'pad', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
});
const held = (p) => p.buttons.map((b, i) => (b.pressed ? i : -1)).filter((i) => i >= 0);

test('the controls are the engine defaults Mania reads', () => {
  assert.deepEqual(RSDKV5_CONTROLS.map((c) => [c.id, c.code, c.button]), [
    ['a', 'KeyA', 0], ['b', 'KeyS', 1], ['x', 'KeyZ', 2], ['y', 'KeyX', 3], ['start', 'Enter', 9], ['select', 'Tab', 8],
    ['up', 'ArrowUp', 12], ['down', 'ArrowDown', 13], ['left', 'ArrowLeft', 14], ['right', 'ArrowRight', 15],
  ]);
});

test('smoothing is a live, labelled setting, pixelated by default', () => {
  const { renderFilter } = RSDKV5_SPEC.config;
  assert.equal(renderFilter.default, 'pixelated');
  assert.equal(renderFilter.live, true);
  assert.equal(renderFilter.group, 'video');
  assert.deepEqual(renderFilter.label, { en: 'Smoothing', es: 'Suavizado' });
});

test('keys and pads are remapped, with swaps', () => {
  const tables = controlTables({ keys: { a: 'KeyJ' }, buttons: { a: 3 } });
  assert.equal(tables.keys.get('KeyJ').code, 'KeyA');
  assert.ok(tables.blocked.has('KeyA'));
  assert.deepEqual(held(remapPad(pad([3]), tables.pad)), [0]);
  const swapped = controlTables({ buttons: { a: 1, b: 0 } });
  assert.deepEqual(held(remapPad(pad([1]), swapped.pad)), [0]);
  assert.deepEqual(held(remapPad(pad([0]), swapped.pad)), [1]);
});

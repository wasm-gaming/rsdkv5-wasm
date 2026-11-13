// Mania's save slots as the SDK reads them from SaveData.bin (globals->saveRAM: int32
// LE, slot s at 0x400*s, SaveRAM fields from +0x58), against the built package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManiaSaves, MANIA_SAVE_SLOTS, MANIA_ZONES, MANIA_CHARACTERS } from '../dist/rsdkv5/rsdkv5.sdk.js';

const file = (slots) => {
  const bytes = new Uint8Array(0x4000 * 4);
  const view = new DataView(bytes.buffer);
  for (const [slot, fields] of Object.entries(slots)) {
    fields.forEach((value, i) => view.setInt32(slot * 0x400 + 0x58 + i * 4, value, true));
  }
  return bytes;
};

test('no file, or a short one, is eight empty slots', () => {
  for (const bytes of [null, new Uint8Array(10)]) {
    const slots = parseManiaSaves(bytes);
    assert.equal(slots.length, MANIA_SAVE_SLOTS);
    assert.ok(slots.every((s) => s.state === 'empty' && s.lives === 3 && s.score === 0));
  }
});

test('a game in progress: character, zone, lives, score, emeralds from the bit mask', () => {
  // saveState, characterID, zoneID, lives, score, score1UP, collectedEmeralds, continues
  const [, s1] = parseManiaSaves(file({ 1: [1, 3, 6, 5, 12340, 50000, 0b1010011, 2] }));
  assert.deepEqual(s1, {
    slot: 1, state: 'progress', character: 3, zone: 6, zoneName: 'Hydrocity',
    lives: 5, score: 12340, emeralds: 4, continues: 2,
  });
  assert.equal(MANIA_CHARACTERS[s1.character], 'Knuckles');
});

test('a completed game, and odd values kept in range', () => {
  const slots = parseManiaSaves(file({ 0: [2, 0, 12, 1, 999, 0, 0x7f, 0], 7: [1, 9, 40, 3, 0, 0, 0, 0] }));
  assert.equal(slots[0].state, 'complete');
  assert.equal(slots[0].zoneName, 'Complete');
  assert.equal(slots[0].emeralds, 7);
  assert.equal(slots[7].character, MANIA_CHARACTERS.length - 1); // clamped
  assert.equal(slots[7].zoneName, 'Unknown zone');
  assert.equal(MANIA_ZONES.length, 13);
});

test('Encore slots (10+) are not read as regular ones', () => {
  const slots = parseManiaSaves(file({ 10: [1, 1, 3, 3, 0, 0, 0, 0] }));
  assert.ok(slots.every((s) => s.state === 'empty'));
});

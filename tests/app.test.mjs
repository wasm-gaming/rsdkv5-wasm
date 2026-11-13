// The app's pure part: which of the game's own screens the pause menu offers, read
// from the engine's stage list. Imports the built app (make build-sdk), which also
// proves it loads next to the SDK with no bundler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGameScreens, mount } from '../dist/rsdkv5/app/app.js';

const list = (name, ...stages) => ({ name, stages: stages.map((s) => ({ name: s })) });

test('the app is an EngineApp: it exports mount()', () => {
  assert.equal(typeof mount, 'function');
});

test('screens are found by name, in any list, trimmed and case-insensitive', () => {
  const lists = [
    list('Presentation', 'Title Screen ', 'Level Select'),
    list('Regular', 'Green Hill 1'),
    list('Special'),
    list('Bonus', 'MENU'),
  ];
  assert.deepEqual(findGameScreens(lists), [
    { label: 'Pantalla de título', list: 0, scene: 0 },
    { label: 'Menú del juego', list: 3, scene: 0 },
    { label: 'Level select', list: 0, scene: 1 },
  ]);
});

test('screens the data does not have are not offered', () => {
  assert.deepEqual(findGameScreens([list('Presentation', 'Logo', 'Intro')]), []);
  assert.deepEqual(findGameScreens([]), []);
  assert.deepEqual(findGameScreens(undefined), []);
  assert.deepEqual(findGameScreens([{ name: 'Broken' }, { stages: [{}] }]), []);
});

test("Sonic CD's STAGE SELECT is the level select", () => {
  assert.deepEqual(findGameScreens([list('Presentation Stages', 'TITLE SCREEN', 'MENU', 'TIME ATTACK', 'STAGE SELECT')]), [
    { label: 'Pantalla de título', list: 0, scene: 0 },
    { label: 'Menú del juego', list: 0, scene: 1 },
    { label: 'Level select', list: 0, scene: 3 },
  ]);
});

test('a name only partly matching is not taken for a screen', () => {
  assert.deepEqual(findGameScreens([list('Presentation', 'TITLE CARD', 'MENU BG', 'LEVEL SELECT 2')]), []);
});

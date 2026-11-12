// The engine owns its folder: every namespace resolves under rsdkv5/, and none can
// climb out of it. Runs against the built SDK (make build-sdk), the module a host
// actually imports — which also proves it loads with no import map or bundler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Rsdkv5SDK, { storagePath } from '../dist/rsdkv5/rsdkv5.sdk.js';

const cases = [
  [undefined, 'default', 'rsdkv5/default', false],
  ['', 'default', 'rsdkv5/default', false],
  [{ id: 'sonic-1' }, 'default', 'rsdkv5/default', false],
  ['sonic-1', 'sonic-1', 'rsdkv5/sonic-1', false],
  ['sonic-2/profile-a', 'sonic-2/profile-a', 'rsdkv5/sonic-2/profile-a', false],
  [' a b /c? ', 'a_b/c_', 'rsdkv5/a_b/c_', false],
  ['../x', 'x', 'rsdkv5/x', false],
  ['./../../etc', 'etc', 'rsdkv5/etc', false],
  ['..', 'default', 'rsdkv5/default', false],
  ['/abs/path', 'abs/path', 'rsdkv5/abs/path', false],
  // the old convention: the prefix is stripped once, so the files stay where they were
  ['rsdkv5/Sonic1', 'Sonic1', 'rsdkv5/Sonic1', true],
  // a game literally named like the engine is not mistaken for the prefix
  ['rsdkv5', 'rsdkv5', 'rsdkv5/rsdkv5', false],
];

for (const [input, namespace, path, prefixed] of cases) {
  test(`storagePath('rsdkv5', ${JSON.stringify(input)}) → ${path}`, () => {
    assert.deepEqual(storagePath('rsdkv5', input), { namespace, path, prefixed });
  });
}

test('the engine id is the folder', () => {
  assert.equal(Rsdkv5SDK.id, 'rsdkv5');
  assert.ok(storagePath(Rsdkv5SDK.id, 'x').path.startsWith(`${Rsdkv5SDK.id}/`));
});

test('the spec says what a host needs to paint its settings', async () => {
  const { RSDKV5_SPEC } = await import('../dist/rsdkv5/rsdkv5.sdk.js');
  assert.deepEqual(RSDKV5_SPEC.assets.data.allowedTypes, ['.rsdk']);
  assert.equal(RSDKV5_SPEC.config.region.default, -1);
  assert.equal(RSDKV5_SPEC.storage.namespace.default, 'default');
});

test('settings.ini follows the config', async () => {
  const { buildSettingsIni } = await import('../dist/rsdkv5/rsdkv5.sdk.js');
  const ini = buildSettingsIni({ devMenu: false, vsync: false, region: 2 });
  assert.match(ini, /^dataFile=Data.rsdk$/m);
  assert.match(ini, /^devMenu=0$/m);
  assert.match(ini, /^vsync=0$/m);
  assert.match(ini, /^region=2$/m);
});

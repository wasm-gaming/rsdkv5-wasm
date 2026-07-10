// Seed dist/settings.ini from src/settings.default.ini, but ONLY if it doesn't
// already exist — so a hand-edited dist/settings.ini is never clobbered by a
// rebuild. Runs as part of build:demo.
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';

const src = new URL('../src/settings.default.ini', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
const dst = new URL('../dist/settings.ini', import.meta.url);

mkdirSync(dist, { recursive: true });

if (existsSync(dst)) {
  console.log('dist/settings.ini already exists — keeping it');
} else {
  copyFileSync(src, dst);
  console.log('seeded dist/settings.ini from src/settings.default.ini');
}

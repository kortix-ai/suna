import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const app = path.resolve(import.meta.dir, '../../..');
const pinned = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')).devDependencies['maplibre-gl'];
const dist = path.join(app, 'node_modules/maplibre-gl/dist');

// After a version change: cp node_modules/maplibre-gl/dist/maplibre-gl.js assets/maplibre/maplibre-gl.webjs
// and cp node_modules/maplibre-gl/dist/maplibre-gl.css assets/maplibre/maplibre-gl-css.webjs
describe('assets/maplibre', () => {
  test('the maplibre-gl devDependency is pinned exactly and installed at that version', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(readFileSync(path.join(dist, '../package.json'), 'utf8')).version).toBe(pinned);
  });

  test('the script and stylesheet are the pinned build, byte for byte', () => {
    expect(readFileSync(path.join(app, 'assets/maplibre/maplibre-gl.webjs')).equals(readFileSync(path.join(dist, 'maplibre-gl.js')))).toBe(true);
    expect(readFileSync(path.join(app, 'assets/maplibre/maplibre-gl-css.webjs')).equals(readFileSync(path.join(dist, 'maplibre-gl.css')))).toBe(true);
  });

  test('the script is a classic self-contained build: it defines the maplibregl global and imports nothing', () => {
    const script = readFileSync(path.join(app, 'assets/maplibre/maplibre-gl.webjs'), 'utf8');
    expect(script).toContain('global.maplibregl = factory()');
    expect(script).not.toMatch(/^import[\s{]/m);
  });
});

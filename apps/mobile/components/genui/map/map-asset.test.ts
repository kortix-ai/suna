import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { buildMaplibreScript } from '../../../scripts/bake-maplibre';

const app = path.resolve(import.meta.dir, '../../..');
const pinned = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8')).devDependencies['maplibre-gl'];
const dist = path.join(app, 'node_modules/maplibre-gl/dist');
const script = readFileSync(path.join(app, 'assets/maplibre/maplibre-gl.webjs'), 'utf8');

// After a version change: pnpm bake:maplibre
describe('assets/maplibre', () => {
  test('the maplibre-gl devDependency is pinned exactly and installed at that version', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(JSON.parse(readFileSync(path.join(dist, '../package.json'), 'utf8')).version).toBe(pinned);
  });

  test('the script and stylesheet are the bake of the pinned build, byte for byte', async () => {
    expect(script).toBe(await buildMaplibreScript());
    expect(script).toContain(`maplibre-gl-js/blob/v${pinned}/LICENSE.txt`);
    expect(readFileSync(path.join(app, 'assets/maplibre/maplibre-gl-css.webjs')).equals(readFileSync(path.join(dist, 'maplibre-gl.css')))).toBe(true);
  });

  test('the script is one classic script: it sets window.maplibregl, starts its worker from a Blob, and imports nothing', () => {
    expect(script).toContain('window.maplibregl=');
    expect(script).toContain('WORKER_URL=');
    expect(script).toContain('(URL.createObjectURL(new Blob([');
    expect(script).not.toMatch(/^\s*(import|export)[\s{*]/m);
    expect(script).not.toContain('import.meta');
  });
});

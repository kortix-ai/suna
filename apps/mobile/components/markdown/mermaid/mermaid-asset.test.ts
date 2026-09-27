import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const app = path.resolve(import.meta.dir, '../../..');
const appPackage = JSON.parse(readFileSync(path.join(app, 'package.json'), 'utf8'));
const webPackage = JSON.parse(readFileSync(path.resolve(app, '../web/package.json'), 'utf8'));
const asset = path.join(app, 'assets/mermaid/mermaid.min.webjs');

describe('assets/mermaid/mermaid.min.webjs', () => {
  test('the mermaid devDependency is pinned exactly', () => {
    expect(appPackage.devDependencies.mermaid).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('the pinned version satisfies web range', () => {
    const [major, minor] = appPackage.devDependencies.mermaid.split('.').map(Number);
    const [webMajor, webMinor] = String(webPackage.dependencies.mermaid).replace(/^[\^~]/, '').split('.').map(Number);
    expect(major).toBe(webMajor);
    expect(minor).toBeGreaterThanOrEqual(webMinor);
  });

  test('is the pinned build, byte for byte (run scripts/sync-mermaid-asset.mjs when this fails)', () => {
    const require = createRequire(path.join(app, 'package.json'));
    const packageJson = require.resolve('mermaid/package.json');
    expect(JSON.parse(readFileSync(packageJson, 'utf8')).version).toBe(appPackage.devDependencies.mermaid);
    const installed = readFileSync(path.join(path.dirname(packageJson), 'dist/mermaid.min.js'));
    expect(readFileSync(asset).equals(installed)).toBe(true);
  });

  test('metro ships the webjs extension as an asset', () => {
    const metro = readFileSync(path.join(app, 'metro.config.js'), 'utf8');
    expect(metro).toContain("'webjs']");
  });
});

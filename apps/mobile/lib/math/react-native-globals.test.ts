import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * React Native defines `window` and `window.navigator` (`{ product: 'ReactNative' }`)
 * but no `navigator.appVersion` or `navigator.userAgent`. MathJax's
 * `util/context.js` calls `window.navigator.appVersion.includes(...)` while its
 * module loads, which threw "Cannot read property 'includes' of undefined" on the
 * device and broke every screen that imports the chat markdown renderer.
 *
 * The check runs in a child process so the React Native globals never leak into
 * the rest of the suite, and it reports through the exit code only (bun test
 * child processes may return empty stdout).
 */
describe('tex-to-svg under React Native globals', () => {
  test('loads and renders with window.navigator lacking appVersion and userAgent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rn-globals-'));
    const script = join(dir, 'probe.ts');
    const texToSvgPath = resolve(import.meta.dir, 'tex-to-svg.ts');
    writeFileSync(
      script,
      [
        "(globalThis as any).window = globalThis;",
        "(globalThis as any).navigator = { product: 'ReactNative' };",
        `const { texToSvg } = await import(${JSON.stringify(texToSvgPath)});`,
        "const out = texToSvg('E = mc^2', false);",
        "if (!out || !String(out.xml).includes('<svg')) process.exit(3);",
        'process.exit(0);',
      ].join('\n'),
    );
    try {
      const child = Bun.spawnSync([process.execPath, script], { stdout: 'ignore', stderr: 'ignore' });
      expect(child.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

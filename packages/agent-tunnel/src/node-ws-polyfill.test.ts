import { describe, expect, test } from 'bun:test';
import { pathToFileURL } from 'node:url';

describe('node WebSocket polyfill', () => {
  test('loads ws when the runtime has no global WebSocket', () => {
    const polyfillUrl = pathToFileURL(`${import.meta.dir}/node-ws-polyfill.ts`).href;
    const script = `
      delete globalThis.WebSocket;
      await import(${JSON.stringify(polyfillUrl)});
      if (typeof globalThis.WebSocket !== 'function') process.exit(1);
    `;

    const result = Bun.spawnSync([process.execPath, '--eval', script]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
  });
});

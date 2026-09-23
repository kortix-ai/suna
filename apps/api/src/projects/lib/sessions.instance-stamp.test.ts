import { describe, expect, test } from 'bun:test';

// Source tripwire, 2026-09-22 (two API instances on one shared local DB).
//
// An ordinary session create inserts the session row and its FIRST prompt in
// one transaction; the sandbox row, which carries the instance stamp, lands
// 0.9–4.2 s later. The drain's instance scope then had no owner signal, any
// instance claimed the prompt, pushed ITS gateway URL into the box, and the
// daemon disposed OpenCode mid-turn when the value flapped. The session row is
// the only owner signal in that window, so every create stamps it — the same
// helper the warm create uses — and the drain falls back to it
// (`engine.ts`, `loadSessionMetadataForSessions`).

const read = (rel: string): Promise<string> => Bun.file(new URL(rel, import.meta.url)).text();

describe('createProjectSession stamps the owning API instance on the session row', () => {
  test('the session metadata ends with instanceStampMetadata(), after every caller-supplied key', async () => {
    const source = await read('./sessions.ts');
    const start = source.indexOf('const requestMetadata = normalizeJsonObject(body.metadata);');
    const end = source.indexOf('.insert(projectSessions)', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const metadataBlock = source.slice(start, end);
    const stamp = metadataBlock.indexOf('...instanceStampMetadata()');
    expect(stamp).toBeGreaterThan(-1);
    // A request body must not be able to claim another instance's sessions.
    expect(stamp).toBeGreaterThan(metadataBlock.indexOf('...requestMetadata'));
    expect(stamp).toBeGreaterThan(metadataBlock.indexOf('...(input.metadata ?? {})'));
  });

  test('it reuses the shared helper, not a second definition', async () => {
    const source = await read('./sessions.ts');
    expect(source).toMatch(/import \{[^}]*\binstanceStampMetadata\b[^}]*\} from '\.\.\/instance-scope';/);
    expect(source).not.toMatch(/function instanceStampMetadata/);
  });
});

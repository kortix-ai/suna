import { describe, expect, mock, test } from 'bun:test';

// Synthetic project templates, so the test does not depend on what the bundled
// templates declare. bunfig `isolation` keeps this mock in this file's process.
const starter = await import('@kortix/starter');
mock.module('@kortix/starter', () => ({
  ...starter,
  getProjectTemplateFiles: () => [
    {
      path: 'messy/kortix.yaml',
      content:
        'env:\n  required: [elevenlabs_api_key, " OPENAI_API_KEY ", 42, {nested: 1}, not a name, OPENAI_API_KEY]\n',
    },
    { path: 'broken/kortix.yaml', content: 'env: [unclosed\n' },
  ],
}));
const { getCatalogEntry } = await import('./catalog');

describe('a project template lists its required secrets', () => {
  test('env.required is read the way the platform reads it: names only, trimmed, upper-cased, once', async () => {
    const entry = await getCatalogEntry('kortix-projects:messy');
    expect(entry?.capabilities.secrets).toEqual(['ELEVENLABS_API_KEY', 'OPENAI_API_KEY']);
  });

  test('an unparseable kortix.yaml lists no secrets', async () => {
    const entry = await getCatalogEntry('kortix-projects:broken');
    expect(entry?.capabilities.secrets).toEqual([]);
  });
});

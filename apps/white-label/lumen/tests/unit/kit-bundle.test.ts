import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundleSource, kitHash, librarySource } from '../../scripts/kit-bundle';

const APP = join(import.meta.dir, '..', '..');

describe('agent kit bundle', () => {
  test('kit.json carries the hash of the kit files: an edit without `bun scripts/kit-bundle.ts` fails here', () => {
    expect(JSON.parse(readFileSync(join(APP, 'agent-kit', 'kit.json'), 'utf8')).hash).toBe(kitHash());
  });

  test('convex/kit/bundle.generated.ts matches agent-kit/', () => {
    expect(readFileSync(join(APP, 'convex', 'kit', 'bundle.generated.ts'), 'utf8')).toBe(bundleSource());
  });

  test('convex/kit/library.generated.ts matches demo-data/dist/ (1 playbook, 2 templates)', async () => {
    expect(readFileSync(join(APP, 'convex', 'kit', 'library.generated.ts'), 'utf8')).toBe(librarySource());
    const { DEFAULT_LIBRARY } = await import('../../convex/kit/library.generated');
    expect(DEFAULT_LIBRARY.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'playbook:Lumen standard NDA playbook', 'template:Engagement Letter', 'template:Mutual Non-Disclosure Agreement',
    ]);
  });

  test('every agent prompt starts with the shared rules and never names the platform', async () => {
    const { KIT } = await import('../../convex/kit/bundle.generated');
    expect(Object.keys(KIT.agents).sort()).toEqual(['lumen-counsel', 'lumen-drafter', 'lumen-extractor', 'lumen-reviewer']);
    for (const prompt of Object.values(KIT.agents)) {
      expect(prompt.startsWith('You work for a law firm through Lumen.')).toBe(true);
      expect(prompt).not.toMatch(/kortix|opencode/i);
    }
    for (const f of KIT.files) expect(`${f.path}\n${f.content}`).not.toMatch(/kortix|opencode/i);
  });
});

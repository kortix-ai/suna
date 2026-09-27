import { describe, expect, test } from 'bun:test';

import { type Catalog, type CatalogModel, catalogModelForWireModel, getManagedModel } from './index';

// `catalogModelForWireModel` maps the three wire-id shapes a gateway request
// carries to one catalog record. A synthetic catalog keeps every row
// independent of the bundled models.dev snapshot; the managed rows read the
// real managed lineup.
const MANAGED_ID = 'deepseek-v4.1-flash';
const managed = getManagedModel(MANAGED_ID)!;

const record = (id: string): CatalogModel => ({ id, name: `record ${id}`, reasoning: true, temperature: false });

const BYOK = record('model-a');
const OPENAI = record('gpt-x');
// Stored under the dashed form of the managed `pricingRef` (`.` → `-`), the
// second lookup candidate.
const MANAGED_REF = record(managed.pricingRef.slice(managed.pricingRef.indexOf('/') + 1).replace(/\./g, '-'));

const catalog: Catalog = {
  source: 'synthetic',
  fetched_at: '2026-01-01T00:00:00.000Z',
  provider_count: 3,
  model_count: 3,
  providers: [
    { id: 'acme', name: 'Acme', models: [BYOK] },
    { id: 'openai', name: 'OpenAI', models: [OPENAI] },
    { id: managed.pricingRef.slice(0, managed.pricingRef.indexOf('/')), name: 'Router', models: [MANAGED_REF] },
  ],
};

describe('catalogModelForWireModel', () => {
  test.each([
    ['a BYOK provider/model id resolves to that provider record', 'acme/model-a', BYOK],
    ['a codex/<id> resolves through the openai/<id> record', 'codex/gpt-x', OPENAI],
    ['a managed bare id resolves through its pricingRef', MANAGED_ID, MANAGED_REF],
    ['an unknown provider/model id resolves to nothing', 'acme/model-b', undefined],
    ['a codex id with no openai record resolves to nothing', 'codex/gpt-y', undefined],
    ['an unknown bare id resolves to nothing', 'not-a-managed-model', undefined],
  ])('%s', (_name, wireModel, expected) => {
    expect(catalogModelForWireModel(wireModel, catalog)).toBe(expected);
  });

  // No attachment field: the curated `vision` flag is applied by the served
  // catalog, not by this record.
  test('a managed bare id with no catalog record gets a minimal permissive record', () => {
    expect(catalogModelForWireModel(MANAGED_ID, { ...catalog, providers: [] })).toEqual({
      id: MANAGED_ID,
      name: managed.name,
      reasoning: true,
      tool_call: true,
      temperature: true,
      limit: managed.limit,
    });
  });
});

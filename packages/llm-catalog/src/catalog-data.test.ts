import { describe, expect, test } from 'bun:test';

import { type Catalog, type CatalogModel, catalogModelForWireModel } from './index';

// `catalogModelForWireModel` maps the wire-id shapes a gateway request carries
// to one catalog record. A synthetic catalog keeps every row independent of the
// bundled models.dev snapshot. A bare id is a Kortix managed model, which this
// catalog does not hold (apps/api answers it from the Platinum lineup).
const record = (id: string): CatalogModel => ({ id, name: `record ${id}`, reasoning: true, temperature: false });

const BYOK = record('model-a');
const OPENAI = record('gpt-x');

const catalog: Catalog = {
  source: 'synthetic',
  fetched_at: '2026-01-01T00:00:00.000Z',
  provider_count: 2,
  model_count: 2,
  providers: [
    { id: 'acme', name: 'Acme', models: [BYOK] },
    { id: 'openai', name: 'OpenAI', models: [OPENAI] },
  ],
};

describe('catalogModelForWireModel', () => {
  test.each([
    ['a BYOK provider/model id resolves to that provider record', 'acme/model-a', BYOK],
    ['a codex/<id> resolves through the openai/<id> record', 'codex/gpt-x', OPENAI],
    ['an unknown provider/model id resolves to nothing', 'acme/model-b', undefined],
    ['a codex id with no openai record resolves to nothing', 'codex/gpt-y', undefined],
    ['a bare (managed) id resolves to nothing here', 'deepseek-v4.1-flash', undefined],
  ])('%s', (_name, wireModel, expected) => {
    expect(catalogModelForWireModel(wireModel, catalog)).toBe(expected);
  });
});

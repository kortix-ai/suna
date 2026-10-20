import { expect, test } from 'bun:test';
import { unavailableCatalog } from './picker-catalog';

test('discovery excludes served models and auto, and identifies access paths', () => {
  expect(unavailableCatalog({
    auto: {},
    served: {},
    managed: { provider: 'kortix' },
    'codex/example': { provider: 'codex' },
    'openai/example': { provider: 'openai' },
  }, { served: {} })).toEqual({
    managed: { provider: 'kortix', availability: 'plan' },
    'codex/example': { provider: 'codex', availability: 'login' },
    'openai/example': { provider: 'openai', availability: 'provider' },
  });
  expect(unavailableCatalog({}, {})).toEqual({});
});

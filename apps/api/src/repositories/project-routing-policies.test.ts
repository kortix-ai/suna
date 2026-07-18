import { beforeEach, expect, mock, test } from 'bun:test';

let selectRows: any[] = [];
let selectCalls = 0;

function selectChain(): any {
  const chain: any = {};
  for (const method of ['from', 'where', 'limit']) chain[method] = () => chain;
  chain.then = (resolve: (rows: any[]) => unknown) => Promise.resolve(resolve(selectRows));
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => {
      selectCalls += 1;
      return selectChain();
    },
  },
  hasDatabase: () => true,
}));

const { getProjectRoutingPolicy } = await import('./project-routing-policies');

beforeEach(() => {
  selectRows = [];
  selectCalls = 0;
});

test('reads current routing policy from the shared DB on every request', async () => {
  selectRows = [];
  expect(await getProjectRoutingPolicy('multi-replica-project')).toBeNull();

  selectRows = [
    {
      visionModel: 'glm-5.2',
      defaultFallbackModels: ['glm-5.2'],
      defaultFallbackOn: 'any-error',
      rules: [],
    },
  ];
  expect(await getProjectRoutingPolicy('multi-replica-project')).toEqual({
    visionModel: 'glm-5.2',
    defaultFallback: { models: ['glm-5.2'], fallbackOn: 'any-error' },
    rules: [],
    modelGenerationConfig: {},
  });
  expect(selectCalls).toBe(2);
});

test('round-trips a stored modelGenerationConfig blob verbatim', async () => {
  selectRows = [
    {
      visionModel: null,
      defaultFallbackModels: null,
      defaultFallbackOn: null,
      rules: [],
      modelGenerationConfig: {
        'openai/gpt-5.6-sol': { reasoningEffort: 'high', maxOutputTokens: 4096 },
      },
    },
  ];
  const policy = await getProjectRoutingPolicy('gen-config-project');
  expect(policy?.modelGenerationConfig).toEqual({
    'openai/gpt-5.6-sol': { reasoningEffort: 'high', maxOutputTokens: 4096 },
  });
});

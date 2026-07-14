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
  });
  expect(selectCalls).toBe(2);
});

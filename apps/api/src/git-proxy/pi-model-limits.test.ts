import { expect, test } from 'bun:test';
import { piModelLimits } from './pi-model-limits';
import { gatewayModelCatalog } from '../llm-gateway/models/catalog-models';

test('binds reasoning support to the selected gateway model', () => {
  const catalog = gatewayModelCatalog('project')['gpt-5.6-luna']!;
  const effort = catalog.reasoning_options?.find(option => option.type === 'effort');
  expect(effort?.values?.length).toBeGreaterThan(0);
  expect(piModelLimits('project', 'gpt-5.6-luna')).toMatchObject({
    reasoning: catalog.reasoning === true,
    reasoningEfforts: effort!.values!.map(value => value === null ? 'none' : value),
  });
});

test('uses the managed gateway limit for the exact selected alias', () => {
  expect(piModelLimits('project', 'kortix/gpt-5.6-luna')).toMatchObject({ model: 'gpt-5.6-luna', context: 1050000 });
  expect(piModelLimits('project', 'gpt-5.6-luna')).toEqual(piModelLimits('project', 'kortix/gpt-5.6-luna'));
});

test('does not borrow a different model limit for an unknown or absent alias', () => {
  expect(piModelLimits('project', 'not-a-real-provider/not-a-model')).toBeUndefined();
  expect(piModelLimits('project', null)).toBeUndefined();
});

import { describe, expect, test } from 'bun:test';
import { DEFAULT_MANAGED_MODEL_IDS } from '@kortix/shared/llm-catalog';
import { chooseDefaultModel } from '../llm-gateway/resolution/choose-default-model';

const MANAGED = DEFAULT_MANAGED_MODEL_IDS[0]!; // a real bare managed id
const BYOK = 'anthropic/claude-sonnet-4-6'; // a non-managed wire model

describe('chooseDefaultModel — precedence (agent > project > account)', () => {
  test('agent DB override beats everything', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefault: 'proj',
        agentDefaults: { release: 'agentdb' },
        agentName: 'release',
      }),
    ).toBe('agentdb');
  });

  test('project default beats account', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefault: 'proj',
        agentDefaults: {},
        agentName: 'release',
      }),
    ).toBe('proj');
  });

  test('account default is the fallback', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefault: null,
        agentDefaults: {},
        agentName: 'release',
      }),
    ).toBe('acc');
  });

  test('nothing configured → undefined (the platform target)', () => {
    expect(
      chooseDefaultModel({ accountDefault: null, agentDefaults: {} }),
    ).toBeUndefined();
  });
});

describe('chooseDefaultModel — free tier', () => {
  test('drops a managed default → undefined (gateway falls back to free)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: MANAGED,
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('drops a kortix/-prefixed managed default → undefined', () => {
    expect(
      chooseDefaultModel({
        accountDefault: `kortix/${MANAGED}`,
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('keeps a BYOK default (not a managed model)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: BYOK,
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBe(BYOK);
  });
});

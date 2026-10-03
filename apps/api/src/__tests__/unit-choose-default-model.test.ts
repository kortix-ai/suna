import { describe, expect, test } from 'bun:test';
import { DEFAULT_MANAGED_MODEL_IDS, PLATFORM_DEFAULT_MODEL_ID } from '@kortix/llm-catalog';
import { chooseDefaultModel } from '../llm-gateway/resolution/choose-default-model';

const PAID_MANAGED = DEFAULT_MANAGED_MODEL_IDS.find((id) => id !== PLATFORM_DEFAULT_MODEL_ID)!;
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
  // KRTX-1067: the platform default is the ONE managed model every tier may
  // use, so a free account keeps it; every other managed model still drops.
  test('keeps the platform default', () => {
    expect(
      chooseDefaultModel({
        accountDefault: PLATFORM_DEFAULT_MODEL_ID,
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBe(PLATFORM_DEFAULT_MODEL_ID);
  });

  test('drops a non-default managed default → undefined (gateway falls back to free)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: PAID_MANAGED,
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('drops a kortix/-prefixed non-default managed default → undefined', () => {
    expect(
      chooseDefaultModel({
        accountDefault: `kortix/${PAID_MANAGED}`,
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

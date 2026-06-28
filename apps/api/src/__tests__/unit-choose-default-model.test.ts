import { describe, expect, test } from 'bun:test';
import { DEFAULT_MANAGED_MODEL_IDS } from '@kortix/shared/llm-catalog';
import { chooseDefaultModel } from '../llm-gateway/resolution/choose-default-model';

const MANAGED = DEFAULT_MANAGED_MODEL_IDS[0]!; // a real bare managed id
const BYOK = 'anthropic/claude-sonnet-4-6'; // a non-managed wire model

describe('chooseDefaultModel — precedence (agent > manifest > project > account)', () => {
  test('agent DB override beats everything', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefaults: { p1: 'proj' },
        agentDefaults: { release: 'agentdb' },
        agentManifestModel: 'manifest',
        projectId: 'p1',
        agentName: 'release',
      }),
    ).toBe('agentdb');
  });

  test('agent manifest model beats project + account when no agent DB override', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefaults: { p1: 'proj' },
        agentDefaults: {},
        agentManifestModel: 'manifest',
        projectId: 'p1',
        agentName: 'release',
      }),
    ).toBe('manifest');
  });

  test('project default beats account', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefaults: { p1: 'proj' },
        agentDefaults: {},
        agentManifestModel: null,
        projectId: 'p1',
        agentName: 'release',
      }),
    ).toBe('proj');
  });

  test('account default is the fallback', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefaults: {},
        agentDefaults: {},
        projectId: 'p1',
        agentName: 'release',
      }),
    ).toBe('acc');
  });

  test('nothing configured → undefined (the platform target)', () => {
    expect(
      chooseDefaultModel({ accountDefault: null, projectDefaults: {}, agentDefaults: {} }),
    ).toBeUndefined();
  });

  test('a project default for a different project is ignored', () => {
    expect(
      chooseDefaultModel({
        accountDefault: 'acc',
        projectDefaults: { other: 'proj' },
        agentDefaults: {},
        projectId: 'p1',
      }),
    ).toBe('acc');
  });
});

describe('chooseDefaultModel — free tier', () => {
  test('drops a managed default → undefined (gateway falls back to free)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: MANAGED,
        projectDefaults: {},
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('drops a kortix/-prefixed managed default → undefined', () => {
    expect(
      chooseDefaultModel({
        accountDefault: `kortix/${MANAGED}`,
        projectDefaults: {},
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBeUndefined();
  });

  test('keeps a BYOK default (not a managed model)', () => {
    expect(
      chooseDefaultModel({
        accountDefault: BYOK,
        projectDefaults: {},
        agentDefaults: {},
        freeModelsOnly: true,
      }),
    ).toBe(BYOK);
  });
});

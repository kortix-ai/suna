/**
 * Each agent runs on its own model (KRTX-2700). The agent's configured model
 * is the baseline; a pick in the composer is an explicit override for THAT
 * agent, resettable, and never leaks to another agent in the same session.
 */
import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Agent, ProviderListResponse } from '../core/runtime/runtime-types';
import { runIdentityResets } from './identity-reset-registry';
import { type RuntimeLocal, type UseRuntimeLocalOptions, useRuntimeLocal } from './use-opencode-local';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const kortix = (modelID: string) => ({ providerID: 'kortix', modelID });
const providers = {
  all: [
    {
      id: 'kortix',
      name: 'Kortix',
      models: {
        'model-a': { id: 'model-a', name: 'Model A' },
        'model-b': { id: 'model-b', name: 'Model B' },
        'model-c': { id: 'model-c', name: 'Model C' },
      },
    },
  ],
  connected: ['kortix'],
  default: { kortix: 'model-a' },
} as unknown as ProviderListResponse;
const agent = (name: string, modelID?: string) =>
  ({ name, mode: 'primary', ...(modelID ? { model: kortix(modelID) } : {}) }) as unknown as Agent;
const agents = [agent('writer', 'model-b'), agent('researcher', 'model-c')];
const resolveServerDefault = () => kortix('model-a');

let root: ReactTestRenderer | undefined;
let latest: RuntimeLocal | undefined;

function Probe(props: UseRuntimeLocalOptions) {
  latest = useRuntimeLocal(props);
  return null;
}

function render(props: UseRuntimeLocalOptions): () => RuntimeLocal {
  act(() => {
    root = create(createElement(Probe, props));
  });
  return () => latest as RuntimeLocal;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  latest = undefined;
  runIdentityResets();
});

test("an agent opens on its own model, on the default, ahead of the server default", () => {
  const local = render({ providers, agents, sessionId: 'ses_1', resolveServerDefault });
  act(() => local().agent.set('writer'));
  expect(local().model.currentKey).toEqual(kortix('model-b'));
  expect(local().model.onDefault).toBe(true);
});

test('a pick for one agent does not follow the user to another agent in the same session', () => {
  const local = render({ providers, agents, sessionId: 'ses_2', resolveServerDefault });
  act(() => local().agent.set('writer'));
  act(() => local().model.set(kortix('model-a'), { recent: true }));
  expect(local().model.sendKey).toEqual(kortix('model-a'));

  act(() => local().agent.set('researcher'));
  expect(local().model.sendKey).toEqual(kortix('model-c'));
  expect(local().model.onDefault).toBe(true);

  act(() => local().agent.set('writer'));
  expect(local().model.sendKey).toEqual(kortix('model-a'));
  expect(local().model.onDefault).toBe(false);
});

test("the session's own model belongs to the agent the session was created with", () => {
  const local = render({
    providers,
    agents,
    sessionId: 'ses_3',
    boundAgentName: 'writer',
    resolveServerDefault,
    projectSession: { metadata: { opencode_model: 'kortix/model-a', opencode_model_source: 'explicit' } },
  });
  expect(local().model.sendKey).toEqual(kortix('model-a'));
  act(() => local().agent.set('researcher'));
  expect(local().model.sendKey).toEqual(kortix('model-c'));
});

test('reset drops the override and returns to the agent model', () => {
  const local = render({ providers, agents, sessionId: 'ses_4', resolveServerDefault });
  act(() => local().agent.set('writer'));
  act(() => local().model.set(kortix('model-c'), { recent: true }));
  expect(local().model.onDefault).toBe(false);

  act(() => local().model.reset());
  expect(local().model.sendKey).toEqual(kortix('model-b'));
  expect(local().model.onDefault).toBe(true);
});

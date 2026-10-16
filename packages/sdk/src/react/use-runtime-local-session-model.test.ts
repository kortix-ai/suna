/**
 * The composer opens on the model the session already runs, not on this
 * browser's picks for other sessions or the account default (audit #68): a
 * session set from the CLI, the SDK or Slack must not switch model on its
 * first web message.
 */
import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ProviderListResponse } from '../core/runtime/runtime-types';
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
// The account default the web resolves through `useModelDefaults`.
const resolveServerDefault = () => kortix('model-a');
const pinned = (pin: string, source: string) => ({
  metadata: { opencode_model: pin, opencode_model_source: source },
});

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

test('a session set from the CLI opens on its model and sends it', () => {
  const local = render({
    providers,
    sessionId: 'ses_cli',
    resolveServerDefault,
    projectSession: pinned('kortix/model-b', 'explicit'),
  });
  expect(local().model.currentKey).toEqual(kortix('model-b'));
  expect(local().model.sendKey).toEqual(kortix('model-b'));
});

test('a session that ran on another model than its default pin opens on that model', () => {
  const local = render({
    providers,
    sessionId: 'ses_web',
    resolveServerDefault,
    projectSession: pinned('kortix/model-b', 'account'),
    lastPromptModel: kortix('model-c'),
  });
  expect(local().model.sendKey).toEqual(kortix('model-c'));
});

test('a pick made in this composer still wins over the session model', () => {
  const local = render({
    providers,
    sessionId: 'ses_pick',
    resolveServerDefault,
    projectSession: pinned('kortix/model-b', 'explicit'),
  });
  act(() => local().model.set(kortix('model-c'), { recent: true }));
  expect(local().model.sendKey).toEqual(kortix('model-c'));
});

test("a session's model never becomes another session's pick", () => {
  render({
    providers,
    sessionId: 'ses_cli',
    resolveServerDefault,
    projectSession: pinned('kortix/model-b', 'explicit'),
    lastPromptModel: kortix('model-b'),
  });
  act(() => root?.unmount());
  const other = render({ providers, sessionId: 'ses_other', resolveServerDefault });
  expect(other().model.sendKey).toEqual(kortix('model-a'));
});

test('a pinned model this viewer is not offered falls back to the default', () => {
  const local = render({
    providers,
    sessionId: 'ses_gone',
    resolveServerDefault,
    projectSession: pinned('kortix/model-gone', 'explicit'),
  });
  expect(local().model.sendKey).toEqual(kortix('model-a'));
});

import { afterEach, expect, test } from 'bun:test';
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Model } from '../core/runtime/runtime-types';
import { runIdentityResets } from './identity-reset-registry';
import { KortixProjectProvider } from './route-project';
import {
  useRuntimeLocal,
  type RuntimeLocal,
  type UseRuntimeLocalOptions,
} from './use-opencode-local';

let root: ReactTestRenderer | undefined;
let latest: RuntimeLocal | undefined;
function Probe(props: UseRuntimeLocalOptions) {
  const value = useRuntimeLocal(props);
  useLayoutEffect(() => {
    latest = value;
  });
  return null;
}
function local() {
  if (!latest) throw new Error('not mounted');
  return latest;
}
const key = (modelID: string) => ({ providerID: 'kortix', modelID });
const model = (id: string): Model => ({
  id,
  name: id,
  providerID: 'kortix',
  api: { id, url: '', npm: '' },
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 100 },
  status: 'active',
  options: {},
  headers: {},
  release_date: '2026-01-01',
  variants: { high: {}, low: {} },
});
const options: UseRuntimeLocalOptions = {
  agentDefaults: true,
  sessionId: 'session-one',
  agents: [
    {
      name: 'worker',
      mode: 'primary',
      options: {},
      permission: [],
      model: key('a'),
      variant: 'high',
    },
  ],
  providers: {
    all: [
      {
        id: 'kortix',
        name: 'Kortix',
        source: 'api',
        env: [],
        options: {},
        models: {
          a: model('a'),
          b: model('b'),
        },
      },
    ],
    connected: ['kortix'],
    default: { kortix: 'b' },
  },
  resolveServerDefault: () => key('b'),
};
function mount(props = options) {
  act(() => {
    root = create(createElement(Probe, props));
  });
}
afterEach(() => {
  act(() => root?.unmount());
  latest = undefined;
  root = undefined;
  runIdentityResets();
});
test('agent model and reasoning are inherited; explicit picks reset durably past session history', () => {
  const pinned = {
    ...options,
    projectSession: {
      metadata: {
        opencode_model: 'kortix/b',
        opencode_model_source: 'explicit',
      },
    },
    lastPromptModel: key('b'),
  };
  mount(pinned);
  expect(local().model.sendKey).toEqual(key('b'));
  act(() => local().model.set(undefined));
  expect(local().model.sendKey).toEqual(key('a'));
  expect(local().model.onDefault).toBe(true);
  expect(local().model.variant.current).toBe('high');
  expect(local().model.variant.onDefault).toBe(true);
  act(() => local().model.variant.set('low'));
  expect(local().model.variant.current).toBe('low');
  expect(local().model.variant.onDefault).toBe(false);
  act(() => local().model.variant.set(undefined));
  expect(local().model.variant.current).toBe('high');
  act(() => root?.unmount());
  mount(pinned);
  expect(local().model.sendKey).toEqual(key('a'));
  act(() => local().model.set(key('b')));
  expect(local().model.onDefault).toBe(false);
  act(() => root?.unmount());
  mount({ ...options, sessionId: 'session-two' });
  expect(local().model.sendKey).toEqual(key('a'));
  expect(local().model.variant.current).toBe('high');
});
test('reasoning override is isolated by session, agent and model', () => {
  mount();
  act(() => local().model.variant.set('low'));
  act(() => root?.update(createElement(Probe, { ...options, sessionId: 'session-two' })));
  expect(local().model.variant.current).toBe('high');
  act(() => root?.update(createElement(Probe, options)));
  expect(local().model.variant.current).toBe('low');
  act(() => local().model.set(key('b')));
  expect(local().model.variant.current).toBe('high');
});
test('changing agent follows inherited defaults without writing an explicit model', () => {
  const agents = [
    ...(options.agents ?? []),
    {
      name: 'reviewer',
      mode: 'primary',
      options: {},
      permission: [],
      model: key('b'),
      variant: 'low',
    } satisfies NonNullable<UseRuntimeLocalOptions['agents']>[number],
  ];
  mount({ ...options, agents });
  expect(local().model.onDefault).toBe(true);
  act(() => local().agent.set('reviewer'));
  expect(local().model.sendKey).toEqual(key('b'));
  expect(local().model.variant.current).toBe('low');
  expect(local().model.onDefault).toBe(true);
  act(() => local().model.variant.set('high'));
  act(() => local().agent.set('worker'));
  expect(local().model.variant.current).toBe('high');
  expect(local().model.variant.onDefault).toBe(true);
});
test.each(['constructor', 'toString', 'missing'])(
  'invalid reasoning override %s preserves the agent baseline',
  (value) => {
    mount();
    act(() => local().model.variant.set(value));
    expect(local().model.variant.current).toBe('high');
    expect(local().model.variant.onDefault).toBe(true);
  },
);

test('history fallback holds only under the agent that produced it', () => {
  const agents = [
    ...(options.agents ?? []),
    {
      name: 'reviewer',
      mode: 'primary',
      options: {},
      permission: [],
      model: key('b'),
      variant: 'low',
    } satisfies NonNullable<UseRuntimeLocalOptions['agents']>[number],
  ];
  // The session's last prompt ran under `worker` on model a. The composer
  // opens on it, and switching agents must follow the NEW agent's model.
  mount({ ...options, agents, lastPromptModel: key('a'), lastPromptAgent: 'worker' });
  expect(local().model.sendKey).toEqual(key('a'));
  act(() => local().agent.set('reviewer'));
  expect(local().model.sendKey).toEqual(key('b'));
  expect(local().model.onDefault).toBe(true);
  expect(local().model.variant.current).toBe('low');
  // The fallback still holds under its own agent: opening `worker` again
  // keeps running the model the session last prompted with.
  act(() => local().agent.set('worker'));
  expect(local().model.sendKey).toEqual(key('a'));
  expect(local().model.onDefault).toBe(false);
});

test('explicit Auto sends no variant; Reset restores the agent default', () => {
  mount();
  act(() => local().model.variant.set('low'));
  expect(local().model.variant.current).toBe('low');
  // The reasoning menu's Auto item: the model's own default applies.
  act(() => local().model.variant.set(null));
  expect(local().model.variant.current).toBeUndefined();
  expect(local().model.variant.onDefault).toBe(false);
  // The pick is durable: a reload keeps sending no variant.
  act(() => root?.unmount());
  mount();
  expect(local().model.variant.current).toBeUndefined();
  expect(local().model.variant.onDefault).toBe(false);
  // The footer's Reset reasoning button: back under the agent default.
  act(() => local().model.variant.set(undefined));
  expect(local().model.variant.current).toBe('high');
  expect(local().model.variant.onDefault).toBe(true);
});

test('route provider isolates composer preferences by project and restores them on return', () => {
  const tree = (projectId: string) =>
    createElement(KortixProjectProvider, { projectId }, createElement(Probe, options));
  act(() => {
    root = create(tree('project-one'));
  });
  act(() => local().model.set(key('b')));
  act(() => local().model.variant.set('low'));
  expect(local().model.sendKey).toEqual(key('b'));
  expect(local().model.variant.current).toBe('low');
  act(() => root?.update(tree('project-two')));
  expect(local().model.sendKey).toEqual(key('a'));
  expect(local().model.onDefault).toBe(true);
  expect(local().model.variant.current).toBe('high');
  expect(local().model.variant.onDefault).toBe(true);
  act(() => root?.update(tree('project-one')));
  expect(local().model.sendKey).toEqual(key('b'));
  expect(local().model.variant.current).toBe('low');
  expect(local().model.variant.onDefault).toBe(false);
});

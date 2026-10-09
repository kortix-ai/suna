/**
 * Characterization tests for the detail sheet's one save.
 *
 * Every assertion goes through the running component, not its source. The
 * sheet edits a draft; "Save changes" sends ONE PATCH holding only the fields
 * that changed, and "Discard" restores the saved values. Each field family
 * (name and instruction, schedule, webhook secret, conditions, agent and
 * model, run location, session access, event settings) is driven through the
 * payload it actually sends, plus the shared lifecycle semantics: a pending
 * footer, one invalidation on success, a failure toast without invalidation.
 *
 * The harness mounts the real sheet under react-test-renderer. Only the
 * portal-based shells (`Sheet`, the dropdown, the selects), the heavy
 * selectors and the connector hook are stubbed — those are collaborators, not
 * the subject. The transport is the real SDK: `updateProjectTrigger` runs
 * against a `configureKortix` fetch override, so every payload below is the
 * body that would hit `PATCH /projects/:id/triggers/:slug`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type ProjectTrigger, configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, createElement } from 'react';
import { type ReactTestInstance, type ReactTestRenderer, act, create } from 'react-test-renderer';

import { Button } from '@/components/ui/button';

type ComponentPropsLike = Record<string, unknown>;

const toastCalls: { kind: 'success' | 'error'; message: string }[] = [];
const realToast = await import('@/components/ui/toast');
const realSdkReact = await import('@kortix/sdk/react');

const selectors: {
  agentSelectors: ComponentPropsLike[];
  modelSelectors: ComponentPropsLike[];
  sharingPickers: ComponentPropsLike[];
  scheduleBuilders: ComponentPropsLike[];
} = { agentSelectors: [], modelSelectors: [], sharingPickers: [], scheduleBuilders: [] };

function Passthrough({ children }: { children?: ReactNode }) {
  return createElement('div', null, children);
}

mock.module('@/components/ui/toast', () => ({
  ...realToast,
  successToast: (message: string) => toastCalls.push({ kind: 'success', message }),
  errorToast: (message: string) => toastCalls.push({ kind: 'error', message }),
}));
mock.module('@/components/ui/sheet', () => ({
  Sheet: Passthrough,
  SheetBody: Passthrough,
  SheetContent: Passthrough,
  SheetDescription: Passthrough,
  SheetHeader: Passthrough,
  SheetTitle: Passthrough,
}));
mock.module('@/components/ui/hint', () => ({ default: Passthrough }));
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: Passthrough,
  DropdownMenuContent: Passthrough,
  DropdownMenuItem: Passthrough,
  DropdownMenuTrigger: Passthrough,
}));
mock.module('@/components/ui/select', () => ({
  Select: Passthrough,
  SelectContent: Passthrough,
  SelectGroup: Passthrough,
  SelectItem: Passthrough,
  SelectTrigger: Passthrough,
  SelectValue: () => null,
}));
mock.module('@/components/scheduled-tasks/schedule-builder', () => ({
  ScheduleBuilder: (props: ComponentPropsLike) => {
    selectors.scheduleBuilders.push(props);
    return createElement('div', { 'data-testid': 'schedule-builder-stub' });
  },
}));
mock.module('@/features/session/model-selector', () => ({
  ModelSelector: (props: ComponentPropsLike) => {
    selectors.modelSelectors.push(props);
    return createElement('div', { 'data-testid': 'model-selector-stub' });
  },
}));
mock.module('@/features/session/session-chat-input', () => ({
  AgentSelector: (props: ComponentPropsLike) => {
    selectors.agentSelectors.push(props);
    return createElement('div', { 'data-testid': 'agent-selector-stub' });
  },
  flattenModels: () => [],
  agentDisplayLabel: (_agents: unknown, slug: string | null) => slug ?? 'Agent',
}));
mock.module('@/features/workspace/shared/sharing-picker', () => ({
  SharingPicker: (props: ComponentPropsLike) => {
    selectors.sharingPickers.push(props);
    return createElement('div', { 'data-testid': 'sharing-picker-stub' });
  },
}));
const catalog: { types: unknown; apps: unknown } = { types: undefined, apps: undefined };
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useVisibleAgents: () => [],
  useRuntimeProviders: () => ({ data: undefined }),
  useFeatureFlag: () => ({ enabled: false, isLoading: false }),
  // A null project id keeps the real hooks idle; so do these.
  useProjectTriggerEventTypes: (projectId: string | null) => ({
    data: projectId ? catalog.types : undefined,
    isLoading: false,
  }),
  useProjectTriggerEventApps: (projectId: string | null) => ({
    data: projectId ? catalog.apps : undefined,
    isLoading: false,
  }),
}));
mock.module('./event-account-picker', () => ({
  EventAccountRows: (props: ComponentPropsLike) => createElement('div', { 'data-testid': 'account-rows-stub', ...props }),
}));
mock.module('./use-event-app-connect', () => ({
  useEventAppConnect: () => ({
    add: async () => 'github-events',
    connect: () => {},
    connecting: null,
    canConnect: true,
  }),
}));

const { ScheduleDetailSheet } = await import('./schedule-detail-sheet');

const mountedRenderers: ReactTestRenderer[] = [];
const calls: { url: string; method: string; body: unknown }[] = [];
let failFetch = false;
let hangFetch = false;
let releaseHang: (() => void) | null = null;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeEach(() => {
  calls.length = 0;
  toastCalls.length = 0;
  selectors.agentSelectors.length = 0;
  selectors.modelSelectors.length = 0;
  selectors.sharingPickers.length = 0;
  selectors.scheduleBuilders.length = 0;
  failFetch = false;
  hangFetch = false;
  releaseHang = null;
  catalog.types = undefined;
  catalog.apps = undefined;
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (hangFetch)
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
        });
      return new Response(JSON.stringify(init.method === 'PATCH' ? { slug: 'triage' } : []), {
        status: failFetch ? 500 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
});

afterEach(() => {
  act(() => {
    for (const r of mountedRenderers.splice(0)) r.unmount();
  });
  hangFetch = false;
  releaseHang?.();
  releaseHang = null;
});

function call(props: ComponentPropsLike, key: string, arg?: unknown) {
  const callback = props[key];
  if (typeof callback !== 'function') throw new Error(`Missing callback: ${key}`);
  callback(arg);
}

function at<T>(items: T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing item at index ${index}`);
  return item;
}


function patches() {
  return calls.filter((c) => c.method === 'PATCH');
}

function expectPatch(body: unknown) {
  expect(patches()).toEqual([
    {
      url: 'http://api.test/v1/projects/proj-1/triggers/triage',
      method: 'PATCH',
      body,
    },
  ]);
}

function success(message: string, count = 1) {
  expect(toastCalls).toEqual(Array.from({ length: count }, () => ({ kind: 'success', message })));
}

type TriggerOverrides = Partial<ProjectTrigger>;

const baseTrigger: ProjectTrigger = {
  slug: 'triage',
  path: 'kortix.yaml#triggers.triage',
  name: 'Inbox triage',
  type: 'cron',
  agent: 'default',
  model: null,
  enabled: true,
  cron: '0 */10 * * * *',
  run_at: null,
  timezone: 'UTC',
  secret_env: null,
  run: null,
  mode: null,
  interval_seconds: null,
  expect_event_within_seconds: null,
  prompt_template: 'Triage the inbox',
  session_mode: 'reuse',
  session_id: null,
  session_key: null,
  filter: null,
  session_access: { mode: 'private', memberIds: [], groupIds: [] },
  last_fired_at: '2026-10-01T06:00:00.000Z',
  last_status: 'fired',
  last_error: null,
  last_attempt_at: '2026-10-01T06:00:00.000Z',
  webhook_url: 'https://api.test/v1/webhooks/triage',
  event: null,
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const deepText = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(deepText).join(' ');

const textOf = (children: unknown): string => {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
};

type Mounted = {
  renderer: ReactTestRenderer;
  onMutated: () => number;
  buttonsWithin: (text: string) => ReactTestInstance[];
  inputById: (id: string) => ReactTestInstance;
  withProps: (key: string) => ReactTestInstance;
  instruction: () => ReactTestInstance;
  openOptions: () => Promise<void>;
  save: () => Promise<void>;
  flush: () => Promise<void>;
};

function mountSheet(
  triggerOverrides: TriggerOverrides = {},
  canWrite = true,
  controls?: { canCreate: boolean; canFire: boolean; canUpdate: boolean; canDelete: boolean },
  eventsEnabled = false,
): Mounted {
  const queryClient = new QueryClient();
  let mutated = 0;
  let mounted: ReactTestRenderer | undefined;
  act(() => {
    mounted = create(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ScheduleDetailSheet, {
          projectId: 'proj-1',
          trigger: { ...baseTrigger, ...triggerOverrides },
          controls: controls ?? { canCreate: canWrite, canFire: canWrite, canUpdate: canWrite, canDelete: canWrite },
          eventsEnabled,
          open: true,
          onOpenChange: () => {},
          onRun: () => {},
          running: false,
          onDelete: () => {},
          onMutated: () => {
            mutated += 1;
          },
        }),
      ),
    );
  });
  if (!mounted) throw new Error('Sheet did not mount');
  const renderer = mounted;
  mountedRenderers.push(renderer);
  const buttonsWithin = (text: string) =>
    renderer.root.findAll((n) => n.type === Button && textOf(n.props.children) === text);
  const sheet: Mounted = {
    renderer,
    onMutated: () => mutated,
    buttonsWithin,
    inputById: (id: string) => {
      const inputs = renderer.root.findAll((n) => n.type === 'input' && n.props?.id === id);
      expect(inputs.length).toBe(1);
      return at(inputs);
    },
    // The one element that takes `key` as a prop: a composer piece like ConditionsEditor or RunLocationFields.
    withProps: (key: string) => {
      const matches = renderer.root.findAll((n) => typeof n.type !== 'string' && n.props?.[key] !== undefined);
      expect(matches.length).toBeGreaterThan(0);
      return at(matches);
    },
    instruction: () => {
      const areas = renderer.root.findAll(
        (n) => typeof n.type !== 'string' && n.props?.['aria-label'] === 'Instruction',
      );
      return at(areas);
    },
    // "Options" is a folded block: its pieces mount when the fold opens.
    openOptions: async () => {
      const fold = renderer.root.findAll(
        (n) => n.type === 'button' && textOf(n.props.children).startsWith('Options'),
      );
      await act(async () => call(at(fold, 0).props, 'onClick', { preventDefault() {} }));
    },
    save: async () => {
      const button = buttonsWithin('Save changes');
      expect(button).toHaveLength(1);
      await act(async () => call(at(button).props, 'onClick'));
    },
    flush: async () => {
      await act(async () => {
        await settle();
      });
    },
  };
  return sheet;
}

const type = async (node: ReactTestInstance, value: string) =>
  act(async () => node.props.onChange({ target: { value } }));

describe('name and instruction', () => {
  test('one PATCH holds both changed fields, trimmed; then it toasts and invalidates once', async () => {
    const sheet = mountSheet();
    await type(sheet.inputById('trigger-name'), '  Inbox triage v2 ');
    await type(sheet.instruction(), 'Triage and label the inbox');
    await sheet.save();
    await sheet.flush();
    expectPatch({ name: 'Inbox triage v2', prompt_template: 'Triage and label the inbox' });
    success('Saved');
    expect(sheet.onMutated()).toBe(1);
  });

  test('only the changed field travels', async () => {
    const sheet = mountSheet();
    await type(sheet.instruction(), 'Different words');
    await sheet.save();
    await sheet.flush();
    expectPatch({ prompt_template: 'Different words' });
  });

  test('nothing changed: no footer, no request', () => {
    const sheet = mountSheet();
    expect(sheet.buttonsWithin('Save changes')).toHaveLength(0);
    expect(sheet.buttonsWithin('Discard')).toHaveLength(0);
    expect(patches()).toHaveLength(0);
  });

  test('Discard restores the saved values and hides the footer', async () => {
    const sheet = mountSheet();
    await type(sheet.inputById('trigger-name'), 'Renamed');
    expect(sheet.inputById('trigger-name').props.value).toBe('Renamed');
    await act(async () => call(at(sheet.buttonsWithin('Discard')).props, 'onClick'));
    expect(sheet.inputById('trigger-name').props.value).toBe('Inbox triage');
    expect(sheet.instruction().props.value).toBe('Triage the inbox');
    expect(sheet.buttonsWithin('Save changes')).toHaveLength(0);
    expect(patches()).toHaveLength(0);
  });

  test('an empty name blocks the save and shows why', async () => {
    const sheet = mountSheet();
    await type(sheet.inputById('trigger-name'), '   ');
    await sheet.save();
    await sheet.flush();
    expect(patches()).toHaveLength(0);
    expect(sheet.renderer.root.findAll((n) => n.props?.role === 'alert').length).toBeGreaterThan(0);
  });

  test('a failed save toasts the error and never invalidates', async () => {
    failFetch = true;
    const sheet = mountSheet();
    await type(sheet.inputById('trigger-name'), 'Renamed');
    await sheet.save();
    await sheet.flush();
    expect(patches()).toHaveLength(1);
    expect(toastCalls.map((t) => t.kind)).toEqual(['error']);
    expect(at(toastCalls, 0).message.length).toBeGreaterThan(0);
    expect(sheet.onMutated()).toBe(0);
  });

  test('the footer reports pending while the request is in flight', async () => {
    hangFetch = true;
    const sheet = mountSheet();
    await type(sheet.inputById('trigger-name'), 'Renamed');
    await sheet.save();
    const pendingNow = () => at(sheet.buttonsWithin('Save changes')).props.disabled === true;
    for (let i = 0; !pendingNow() && i < 50; i++) await sheet.flush();
    expect(pendingNow()).toBe(true);
    expect(at(sheet.buttonsWithin('Discard')).props.disabled).toBe(true);
    expect(toastCalls).toEqual([]);
    expect(sheet.onMutated()).toBe(0);
  });
});

describe('schedule', () => {
  test('a new cron expression is sent with run_at cleared', async () => {
    const sheet = mountSheet();
    await act(async () => call(at(selectors.scheduleBuilders, 0), 'onChange', '0 0 8 * * *'));
    await sheet.save();
    await sheet.flush();
    expectPatch({ cron: '0 0 8 * * *', run_at: null, timezone: 'UTC' });
    expect(sheet.onMutated()).toBe(1);
  });

  test('a one-off run time is sent with cron cleared', async () => {
    const sheet = mountSheet();
    await act(async () =>
      call(at(selectors.scheduleBuilders, 0), 'onRunAtChange', '2031-01-02T09:00:00.000Z'),
    );
    await sheet.save();
    await sheet.flush();
    expectPatch({ run_at: '2031-01-02T09:00:00.000Z', cron: null, timezone: 'UTC' });
  });
});

describe('webhook', () => {
  test('shows its address and sends the trimmed signing key name', async () => {
    const sheet = mountSheet({ type: 'webhook', cron: null, secret_env: 'WEBHOOK_OLD' });
    const text = JSON.stringify(sheet.renderer.toJSON());
    expect(text).toContain('https://api.test/v1/webhooks/triage');
    await type(sheet.inputById('webhook-signing-key'), 'WEBHOOK_NEW');
    await sheet.save();
    await sheet.flush();
    expectPatch({ secret_env: 'WEBHOOK_NEW' });
  });
});

describe('options', () => {
  test('conditions are sent as the filter object', async () => {
    const sheet = mountSheet({ type: 'webhook', cron: null });
    await sheet.openOptions();
    await act(async () =>
      call(at(sheet.renderer.root.findAll((n) => typeof n.type !== 'string' && Array.isArray(n.props?.rows))).props, 'onChange', [{ path: 'event', value: 'push' }]),
    );
    await sheet.save();
    await sheet.flush();
    expectPatch({ filter: { event: 'push' } });
  });

  test('a schedule has no conditions', async () => {
    const sheet = mountSheet();
    await sheet.openOptions();
    expect(sheet.renderer.root.findAll((n) => Array.isArray(n.props?.rows))).toHaveLength(0);
  });

  test('a grouping key is sent with the keyed mode and no session id', async () => {
    const sheet = mountSheet();
    await sheet.openOptions();
    const fields = sheet.withProps('onModeChange').props;
    await act(async () => call(fields, 'onModeChange', 'keyed'));
    await act(async () =>
      call(sheet.withProps('onSessionKeyChange').props, 'onSessionKeyChange', ' team-a '),
    );
    await sheet.save();
    await sheet.flush();
    expectPatch({ session_mode: 'keyed', session_key: 'team-a', session_id: null });
  });

  test('pinning a session sends the pinned mode with the id', async () => {
    const sheet = mountSheet();
    await sheet.openOptions();
    await act(async () => call(sheet.withProps('onModeChange').props, 'onModeChange', 'pinned'));
    await act(async () =>
      call(sheet.withProps('onPinnedSessionChange').props, 'onPinnedSessionChange', 'sess-1'),
    );
    await sheet.save();
    await sheet.flush();
    expectPatch({ session_mode: 'pinned', session_id: 'sess-1', session_key: null });
  });

  test('a standalone mode clears the staged values', async () => {
    const sheet = mountSheet({ session_mode: 'keyed', session_key: 'x' });
    await sheet.openOptions();
    await act(async () => call(sheet.withProps('onModeChange').props, 'onModeChange', 'fresh'));
    await sheet.save();
    await sheet.flush();
    expectPatch({ session_mode: 'fresh', session_id: null, session_key: null });
  });

  test('a sharing selection is sent as session_access', async () => {
    const sheet = mountSheet();
    await sheet.openOptions();
    const picker = at(selectors.sharingPickers, selectors.sharingPickers.length - 1);
    await act(async () =>
      call(picker, 'onChange', { mode: 'members', memberIds: ['user-1'], groupIds: ['group-1'] }),
    );
    await sheet.save();
    await sheet.flush();
    expectPatch({
      session_access: { mode: 'members', memberIds: ['user-1'], groupIds: ['group-1'] },
    });
  });
});

describe('agent and model', () => {
  test('selecting an agent sends { agent }', async () => {
    const sheet = mountSheet();
    await act(async () => call(at(selectors.agentSelectors, 0), 'onSelect', 'support-agent'));
    await sheet.save();
    await sheet.flush();
    expectPatch({ agent: 'support-agent' });
  });

  test('selecting a model sends its wire form; clearing sends null', async () => {
    const sheet = mountSheet();
    await act(async () =>
      call(at(selectors.modelSelectors, 0), 'onSelect', { providerID: 'openai', modelID: 'gpt-5' }),
    );
    await sheet.save();
    await sheet.flush();
    expectPatch({ model: 'openai/gpt-5' });

    calls.length = 0;
    toastCalls.length = 0;
    const pinned = mountSheet({ model: 'openai/gpt-4' });
    const latest = at(selectors.modelSelectors, selectors.modelSelectors.length - 1);
    await act(async () => call(latest, 'onSelect', null));
    await pinned.save();
    await pinned.flush();
    expectPatch({ model: null });
  });
});

describe('an app event', () => {
  const eventTypes = {
    provider: 'composio',
    app: 'github',
    event_types: [
      {
        type: 'GITHUB_COMMIT_EVENT',
        name: 'Commit Event',
        description: 'A commit lands',
        app: 'github',
        delivery: 'poll',
        config_schema: {
          type: 'object',
          required: ['repo'],
          properties: { repo: { type: 'string' } },
        },
        payload_schema: { properties: { commit_sha: { description: 'The sha' } } },
      },
      {
        type: 'GITHUB_BRANCH_CREATED_TRIGGER',
        name: 'New Branch Created',
        description: 'A branch is created',
        app: 'github',
        delivery: 'push',
        config_schema: { type: 'object', properties: {} },
        payload_schema: null,
      },
    ],
  };
  const accounts = (extra = {}) => [
    { label: 'Project connection', connected_as: 'acme-org', is_default: true, connected: true, ...extra },
    { label: 'acme-bot', connected_as: null, is_default: false, connected: true },
  ];
  const apps = {
    apps: [
      {
        source: 'composio',
        provider: 'composio',
        app: 'github',
        name: 'GitHub',
        logo: null,
        event_count: 2,
        new_connector_slug: 'github-events',
        connector: 'github-work',
        connected: true,
        connectors: [
          { slug: 'github-work', name: 'GitHub work', accounts: accounts() },
          { slug: 'github', name: 'github', accounts: [] },
        ],
      },
    ],
  };
  const eventOverrides: TriggerOverrides = {
    type: 'event',
    cron: null,
    prompt_template: 'Look at the commit',
    event: {
      connector: 'github-work',
      account: null,
      type: 'GITHUB_COMMIT_EVENT',
      config: { repo: 'acme/api' },
      provider: 'composio',
      app: 'github',
      status: 'active',
      error: null,
      last_event_at: null,
    },
  };
  const mountEvent = (over: TriggerOverrides = {}, eventsEnabled = true) => {
    catalog.types = eventTypes;
    catalog.apps = apps;
    return mountSheet({ ...eventOverrides, ...over }, true, undefined, eventsEnabled);
  };

  test('changing the instruction and the account sends one PATCH with both fields', async () => {
    const sheet = mountEvent();
    await type(sheet.instruction(), 'Review {{ event.data.commit_sha }}');
    await act(async () => call(sheet.withProps('connector').props, 'onChange', 'acme-bot'));
    await sheet.save();
    await sheet.flush();
    expectPatch({ prompt_template: 'Review {{ event.data.commit_sha }}', event_account: 'acme-bot' });
    expect(sheet.onMutated()).toBe(1);
  });

  test('changing the event sends the new type with its fresh config', async () => {
    const sheet = mountEvent();
    await act(async () => call(at(sheet.buttonsWithin('Change')).props, 'onClick'));
    const pick = sheet.renderer.root.findAll(
      (n) => n.type === 'button' && deepText(n).includes('New Branch Created'),
    );
    expect(pick.length).toBeGreaterThan(0);
    await act(async () => call(at(pick, 0).props, 'onClick'));
    await sheet.save();
    await sheet.flush();
    expectPatch({ event: 'GITHUB_BRANCH_CREATED_TRIGGER', event_config: {} });
  });

  test('another connector is sent with its account, so the old one never carries over', async () => {
    const sheet = mountEvent();
    const select = sheet.renderer.root.findAll(
      (n) => typeof n.type !== 'string' && typeof n.props?.onValueChange === 'function' && n.props?.value === 'github-work',
    );
    await act(async () => call(at(select, 0).props, 'onValueChange', 'github'));
    await sheet.save();
    await sheet.flush();
    expectPatch({ connector: 'github', event_account: null });
  });

  test('a trigger that needs a connection offers to connect it', () => {
    const sheet = mountEvent({
      event: { ...(eventOverrides.event as NonNullable<ProjectTrigger['event']>), status: 'needs_connection' },
    });
    expect(sheet.buttonsWithin('Connect github').length + sheet.buttonsWithin('Connect GitHub').length).toBe(1);
  });

  test('events off: the catalog is not used, the saved event is shown and other fields still save', async () => {
    const sheet = mountEvent(
      { event: { ...(eventOverrides.event as NonNullable<ProjectTrigger['event']>), status: 'error', error: 'App event triggers are off for this project.' } },
      false,
    );
    const text = JSON.stringify(sheet.renderer.toJSON());
    expect(text).toContain('App event triggers are off');
    expect(sheet.buttonsWithin('Change')).toHaveLength(0);
    await type(sheet.instruction(), 'Still editable');
    await sheet.save();
    await sheet.flush();
    expectPatch({ prompt_template: 'Still editable' });
  });
});

describe('the header toggle', () => {
  test('pausing sends { enabled: false } and invalidates once', async () => {
    const sheet = mountSheet();
    const pause = sheet.buttonsWithin('Pause');
    expect(pause.length).toBe(1);
    await act(async () => call(at(pause, 0).props, 'onClick'));
    await sheet.flush();
    expectPatch({ enabled: false });
    expect(toastCalls.map((t) => t.kind)).toEqual(['success']);
    expect(sheet.onMutated()).toBe(1);
  });
});

// KRTX-1720: Run now, Pause and Delete each follow their own leaf.
describe('header controls follow one leaf each', () => {
  const none = { canCreate: false, canFire: false, canUpdate: false, canDelete: false };

  test('a member who may only fire gets Run now, and no Pause', () => {
    const sheet = mountSheet({}, false, { ...none, canFire: true });
    expect(sheet.buttonsWithin('Run now')).toHaveLength(1);
    expect(sheet.buttonsWithin('Pause')).toHaveLength(0);
  });

  test('an update-only role gets Pause, and no Run now', () => {
    const sheet = mountSheet({}, false, { ...none, canUpdate: true });
    expect(sheet.buttonsWithin('Pause')).toHaveLength(1);
    expect(sheet.buttonsWithin('Run now')).toHaveLength(0);
  });

  test('no leaf: no header control at all, and the body is read-only', () => {
    const sheet = mountSheet({}, false, none);
    expect(sheet.buttonsWithin('Run now')).toHaveLength(0);
    expect(sheet.buttonsWithin('Pause')).toHaveLength(0);
    expect(sheet.renderer.root.findAll((n) => n.type === 'input' && n.props?.id === 'trigger-name')).toHaveLength(0);
    expect(JSON.stringify(sheet.renderer.toJSON())).toContain('Triage the inbox');
  });
});

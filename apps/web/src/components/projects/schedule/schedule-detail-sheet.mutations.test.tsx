/**
 * Characterization tests for the detail sheet's trigger-update mutations.
 *
 * Every assertion goes through the running component, not its source. Each of the eight
 * editable-panel mutations (WhatItDoes, WhenItRuns, Address, Conditions,
 * Agent ×2, Memory, Access) is driven through the payload it actually sends,
 * plus the shared lifecycle semantics: pending controls, one invalidation on
 * success, a failure toast without invalidation, and the timing editor that
 * closes only after success.
 *
 * The harness mounts the real sheet under react-test-renderer. Only the
 * portal-based shells (`Sheet`, the dropdown, the selects) and the two heavy
 * selectors are stubbed — those are collaborators, not the subject. The
 * transport is the real SDK: `updateProjectTrigger` runs against a
 * `configureKortix` fetch override, so every payload below is the body that
 * would hit `PATCH /projects/:id/triggers/:slug`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { type ProjectTrigger, configureKortix } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, createElement } from 'react';
import { type ReactTestInstance, type ReactTestRenderer, act, create } from 'react-test-renderer';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { PanelSection, SaveButton } from './schedule-fields';

type ComponentPropsLike = Record<string, unknown>;

const toastCalls: { kind: 'success' | 'error'; message: string }[] = [];
const realToast = await import('@/components/ui/toast');
const realSdkReact = await import('@kortix/sdk/react');
const realFields = await import('./schedule-fields');

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
}));
mock.module('@/features/workspace/shared/sharing-picker', () => ({
  SharingPicker: (props: ComponentPropsLike) => {
    selectors.sharingPickers.push(props);
    return createElement('div', { 'data-testid': 'sharing-picker-stub' });
  },
}));
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useVisibleAgents: () => [],
  useRuntimeProviders: () => ({ data: undefined }),
  useFeatureFlag: () => ({ enabled: false, isLoading: false }),
}));

const { ScheduleDetailSheet } = await import('./schedule-detail-sheet');

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
      return new Response(JSON.stringify({ slug: 'triage' }), {
        status: failFetch ? 500 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
});

afterEach(() => {
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

function expectPatch(body: unknown) {
  expect(calls).toEqual([
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
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

type SaveButtonProps = { dirty: boolean; pending: boolean; onSave: () => void };

type Mounted = {
  renderer: ReactTestRenderer;
  onMutated: () => number;
  sectionBy: (predicate: (section: ReactTestInstance) => boolean) => ReactTestInstance;
  saveButtonOf: (section: ReactTestInstance) => SaveButtonProps;
  buttonsWithin: (section: ReactTestInstance | null, text: string) => ReactTestInstance[];
  inputById: (id: string) => ReactTestInstance;
  stubCount: (testId: string) => number;
  flush: () => Promise<void>;
};

function mountSheet(triggerOverrides: TriggerOverrides = {}, canWrite = true): Mounted {
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
          canWrite,
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
  const textOf = (children: unknown): string => {
    if (typeof children === 'string') return children;
    if (typeof children === 'number') return String(children);
    if (Array.isArray(children)) return children.map(textOf).join('');
    return '';
  };
  const sections = () => renderer.root.findAll((n) => n.type === PanelSection);
  return {
    renderer,
    onMutated: () => mutated,
    sectionBy: (predicate) => {
      const matches = sections().filter(predicate);
      expect(matches.length).toBe(1);
      return at(matches);
    },
    saveButtonOf: (section: ReactTestInstance) => {
      const buttons = section.findAll((n) => n.type === SaveButton);
      expect(buttons.length).toBe(1);
      const props: ComponentPropsLike = at(buttons).props;
      if (
        typeof props.dirty !== 'boolean' ||
        typeof props.pending !== 'boolean' ||
        typeof props.onSave !== 'function'
      )
        throw new Error('Invalid SaveButton props');
      return { dirty: props.dirty, pending: props.pending, onSave: () => call(props, 'onSave') };
    },
    buttonsWithin: (section: ReactTestInstance | null, text: string) =>
      (section
        ? section.findAll((n) => n.type === Button)
        : renderer.root.findAll((n) => n.type === Button)
      ).filter((b) => textOf(b.props.children) === text),
    inputById: (id: string) => {
      const inputs = renderer.root.findAll((n) => n.type === 'input' && n.props?.id === id);
      expect(inputs.length).toBe(1);
      return at(inputs);
    },
    stubCount: (testId: string) =>
      renderer.root.findAll((n) => n.props?.['data-testid'] === testId).length,
    flush: async () => {
      await act(async () => {
        await settle();
      });
    },
  };
}

const whatItDoesSection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) => s.findAll((n) => n.type === 'input' && n.props?.id === 'schedule-name').length > 0,
  );
const whenItRunsReadSection = (sheet: Mounted) =>
  sheet.sectionBy((s) => s.findAll((n) => n.type === realFields.PropertyList).length > 0);
const whenItRunsEditSection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) => s.findAll((n) => n.props?.['data-testid'] === 'schedule-builder-stub').length > 0,
  );
const addressSection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) => s.findAll((n) => n.type === 'input' && n.props?.id === 'webhook-signing-key').length > 0,
  );
const conditionsSection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) =>
      s.findAll((n) => typeof n.props?.onChange === 'function' && Array.isArray(n.props?.rows))
        .length > 0,
  );
const agentSection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) => s.findAll((n) => n.props?.['data-testid'] === 'agent-selector-stub').length > 0,
  );
const memorySection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) => s.findAll((n) => typeof n.props?.onSessionKeyChange === 'function').length > 0,
  );
const accessSection = (sheet: Mounted) =>
  sheet.sectionBy(
    (s) => s.findAll((n) => n.props?.['data-testid'] === 'sharing-picker-stub').length > 0,
  );

describe('what-it-does panel update', () => {
  test('sends the trimmed name and the instruction, then toasts and invalidates once', async () => {
    const sheet = mountSheet();
    const name = sheet.inputById('schedule-name');
    await act(async () => name.props.onChange({ target: { value: '  Inbox triage v2 ' } }));
    const save = sheet.saveButtonOf(whatItDoesSection(sheet));
    expect(save.dirty).toBe(true);
    await act(async () => save.onSave());
    await sheet.flush();
    expectPatch({ name: 'Inbox triage v2', prompt_template: 'Triage the inbox' });
    success('Saved');
    expect(sheet.onMutated()).toBe(1);
  });

  test('a failed save toasts the error and never invalidates', async () => {
    failFetch = true;
    const sheet = mountSheet();
    const name = sheet.inputById('schedule-name');
    await act(async () => name.props.onChange({ target: { value: 'Renamed' } }));
    const save = sheet.saveButtonOf(whatItDoesSection(sheet));
    await act(async () => save.onSave());
    await sheet.flush();
    expect(calls).toHaveLength(1);
    expect(toastCalls.map((t) => t.kind)).toEqual(['error']);
    expect(at(toastCalls, 0).message.length).toBeGreaterThan(0);
    expect(sheet.onMutated()).toBe(0);
  });

  test('the save control reports pending while the request is in flight', async () => {
    hangFetch = true;
    const sheet = mountSheet();
    const name = sheet.inputById('schedule-name');
    await act(async () => name.props.onChange({ target: { value: 'Renamed' } }));
    await act(async () => {
      sheet.saveButtonOf(whatItDoesSection(sheet)).onSave();
      await settle();
      // React-query batches observer notifications; wait for the pending render.
      let save = sheet.saveButtonOf(whatItDoesSection(sheet));
      for (let i = 0; !save.pending && i < 50; i++) {
        await settle();
        save = sheet.saveButtonOf(whatItDoesSection(sheet));
      }
      expect(save.pending).toBe(true);
      expect(save.dirty).toBe(true);
      // Nothing resolved while the request hangs.
      expect(toastCalls).toEqual([]);
      expect(sheet.onMutated()).toBe(0);
    });
  });
});

describe('when-it-runs panel update', () => {
  const enterEditing = async (sheet: Mounted) => {
    const edit = sheet.buttonsWithin(whenItRunsReadSection(sheet), 'Edit');
    expect(edit.length).toBe(1);
    await act(async () => call(at(edit, 0).props, 'onClick'));
    expect(selectors.scheduleBuilders.length).toBe(1);
  };
  const saveButton = (sheet: Mounted) => {
    const section = whenItRunsEditSection(sheet);
    return sheet.buttonsWithin(section, 'Save');
  };

  test('sends the cron expression with run_at cleared, then closes the editor', async () => {
    const sheet = mountSheet();
    await enterEditing(sheet);
    await act(async () => call(at(selectors.scheduleBuilders, 0), 'onChange', '0 0 11 * * *'));
    const buttons = saveButton(sheet);
    expect(buttons.length).toBe(1);
    await act(async () => call(at(buttons, 0).props, 'onClick'));
    await sheet.flush();
    expectPatch({ cron: '0 0 11 * * *', run_at: null, timezone: 'UTC' });
    expect(sheet.stubCount('schedule-builder-stub')).toBe(0);
    success('Schedule updated');
    expect(sheet.onMutated()).toBe(1);
  });

  test('a one-off run time is sent with cron cleared', async () => {
    const sheet = mountSheet();
    await enterEditing(sheet);
    await act(async () =>
      call(at(selectors.scheduleBuilders, 0), 'onRunAtChange', '2026-12-01T09:00:00Z'),
    );
    const buttons = saveButton(sheet);
    await act(async () => call(at(buttons, 0).props, 'onClick'));
    await sheet.flush();
    expectPatch({ run_at: '2026-12-01T09:00:00Z', cron: null, timezone: 'UTC' });
    success('Schedule updated');
    expect(sheet.onMutated()).toBe(1);
  });

  test('the editor stays open while the save is pending and closes once it succeeds', async () => {
    hangFetch = true;
    const sheet = mountSheet();
    await enterEditing(sheet);
    await act(async () => call(at(selectors.scheduleBuilders, 0), 'onChange', '0 0 11 * * *'));
    const buttons = saveButton(sheet);
    await act(async () => call(at(buttons, 0).props, 'onClick'));
    expect(sheet.stubCount('schedule-builder-stub')).toBe(1);
    expect(sheet.onMutated()).toBe(0);
    releaseHang?.();
    await sheet.flush();
    expect(sheet.stubCount('schedule-builder-stub')).toBe(0);
    success('Schedule updated');
    expect(sheet.onMutated()).toBe(1);
  });

  test('a failed save keeps the editor open', async () => {
    failFetch = true;
    const sheet = mountSheet();
    await enterEditing(sheet);
    await act(async () => call(at(selectors.scheduleBuilders, 0), 'onChange', '0 0 11 * * *'));
    const buttons = saveButton(sheet);
    await act(async () => call(at(buttons, 0).props, 'onClick'));
    await sheet.flush();
    expect(sheet.stubCount('schedule-builder-stub')).toBe(1);
    expect(sheet.onMutated()).toBe(0);
    expect(toastCalls.map((t) => t.kind)).toEqual(['error']);
  });
});

describe('address panel update', () => {
  test('sends the trimmed signing key name', async () => {
    const sheet = mountSheet({ type: 'webhook', secret_env: 'WEBHOOK_OLD' });
    const secretInput = sheet.inputById('webhook-signing-key');
    expect(secretInput.props.value).toBe('WEBHOOK_OLD');
    await act(async () => secretInput.props.onChange({ target: { value: 'webhook_new ' } }));
    const save = sheet.saveButtonOf(addressSection(sheet));
    expect(save.dirty).toBe(true);
    await act(async () => save.onSave());
    await sheet.flush();
    expectPatch({ secret_env: 'WEBHOOK_NEW' });
    success('Signing key updated');
    expect(sheet.onMutated()).toBe(1);
  });
});

describe('conditions panel update', () => {
  test('sends the rows converted back to the filter object', async () => {
    const sheet = mountSheet({ type: 'webhook', filter: { 'message.source': 'github' } });
    const section = conditionsSection(sheet);
    const editor = at(
      section.findAll(
        (n) => typeof n.props?.onChange === 'function' && Array.isArray(n.props?.rows),
      ),
    );
    expect(editor).toBeDefined();
    await act(async () =>
      call(editor.props, 'onChange', [
        { path: 'message.source', value: 'github' },
        { path: 'event', value: 'push' },
      ]),
    );
    const save = sheet.saveButtonOf(conditionsSection(sheet));
    expect(save.dirty).toBe(true);
    await act(async () => save.onSave());
    await sheet.flush();
    expectPatch({ filter: { 'message.source': 'github', event: 'push' } });
    success('Conditions saved');
    expect(sheet.onMutated()).toBe(1);
  });
});

describe('agent panel updates', () => {
  test('selecting an agent sends { agent }', async () => {
    const sheet = mountSheet();
    const agentSelector = at(selectors.agentSelectors, 0);
    await act(async () => call(agentSelector, 'onSelect', 'support-agent'));
    await sheet.flush();
    expectPatch({ agent: 'support-agent' });
    success('Agent updated');
    expect(sheet.onMutated()).toBe(1);
  });

  test('selecting a model sends its wire form; clearing sends null', async () => {
    const sheet = mountSheet();
    const modelSelector = at(selectors.modelSelectors, 0);
    const key = { providerID: 'openai', modelID: 'gpt-5' };
    await act(async () => call(modelSelector, 'onSelect', key));
    await sheet.flush();
    expect(calls).toHaveLength(1);
    expect(at(calls, 0).body).toEqual({ model: 'openai/gpt-5' });
    success('Model updated');
    expect(sheet.onMutated()).toBe(1);
    await act(async () => call(at(selectors.modelSelectors, 0), 'onSelect', null));
    await sheet.flush();
    expect(at(calls, 1).body).toEqual({ model: null });
    success('Model updated', 2);
    expect(sheet.onMutated()).toBe(2);
  });
});

describe('memory panel updates', () => {
  test('pinning a session sends the pinned mode with the id', async () => {
    const sheet = mountSheet();
    const fields = at(
      memorySection(sheet).findAll((n) => typeof n.props?.onPinnedSessionChange === 'function'),
    );
    expect(fields).toBeDefined();
    await act(async () => call(fields.props, 'onPinnedSessionChange', 'sess-1'));
    await sheet.flush();
    expectPatch({ session_mode: 'pinned', session_id: 'sess-1', session_key: null });
    success('Updated');
    expect(sheet.onMutated()).toBe(1);
  });

  test('saving a grouping key sends the keyed mode with the key', async () => {
    const sheet = mountSheet();
    // The grouping input and its save action only render in the keyed view.
    const modeSelect = at(memorySection(sheet).findAll((n) => n.type === Select));
    await act(async () => call(modeSelect.props, 'onValueChange', 'keyed'));
    const fields = at(
      memorySection(sheet).findAll((n) => typeof n.props?.onSessionKeyChange === 'function'),
    );
    await act(async () => call(fields.props, 'onSessionKeyChange', 'team-a'));
    const save = sheet.saveButtonOf(memorySection(sheet));
    expect(save.dirty).toBe(true);
    await act(async () => save.onSave());
    await sheet.flush();
    expectPatch({ session_mode: 'keyed', session_key: 'team-a', session_id: null });
    success('Updated');
    expect(sheet.onMutated()).toBe(1);
  });

  test('switching to a standalone mode saves immediately and clears the staged values', async () => {
    const sheet = mountSheet();
    const modeSelect = at(memorySection(sheet).findAll((n) => n.type === Select));
    expect(modeSelect).toBeDefined();
    await act(async () => call(modeSelect.props, 'onValueChange', 'private'));
    await sheet.flush();
    expectPatch({ session_mode: 'private', session_id: null, session_key: null });
    success('Updated');
    expect(sheet.onMutated()).toBe(1);
  });
});

describe('access panel update', () => {
  test('a sharing selection is staged, then saved as session_access', async () => {
    const sheet = mountSheet();
    const picker = at(selectors.sharingPickers, 0);
    await act(async () =>
      call(picker, 'onChange', { mode: 'members', memberIds: ['user-1'], groupIds: ['group-1'] }),
    );
    const save = sheet.saveButtonOf(accessSection(sheet));
    expect(save.dirty).toBe(true);
    await act(async () => save.onSave());
    await sheet.flush();
    expectPatch({
      session_access: { mode: 'members', memberIds: ['user-1'], groupIds: ['group-1'] },
    });
    success('Session access updated');
    expect(sheet.onMutated()).toBe(1);
  });
});

// Each case drives the real panel callback; only selectors and portal shells are stubs.
const lifecycleCases: {
  name: string;
  section: (sheet: Mounted) => ReactTestInstance;
  change: (sheet: Mounted) => void;
  immediate?: boolean;
}[] = [
  {
    name: 'Address',
    section: addressSection,
    change: (sheet) =>
      call(sheet.inputById('webhook-signing-key').props, 'onChange', {
        target: { value: 'WEBHOOK_NEW' },
      }),
  },
  {
    name: 'Conditions',
    section: conditionsSection,
    change: (sheet) =>
      call(
        at(conditionsSection(sheet).findAll((n) => Array.isArray(n.props.rows))).props,
        'onChange',
        [{ path: 'event', value: 'push' }],
      ),
  },
  {
    name: 'Agent selection',
    section: agentSection,
    immediate: true,
    change: () => call(at(selectors.agentSelectors), 'onSelect', 'support-agent'),
  },
  {
    name: 'Model selection',
    section: agentSection,
    immediate: true,
    change: () =>
      call(at(selectors.modelSelectors), 'onSelect', { providerID: 'openai', modelID: 'gpt-5' }),
  },
  {
    name: 'Memory',
    section: memorySection,
    change: (sheet) =>
      call(
        at(memorySection(sheet).findAll((n) => typeof n.props.onSessionKeyChange === 'function'))
          .props,
        'onSessionKeyChange',
        'team-a',
      ),
  },
  {
    name: 'Access',
    section: accessSection,
    change: () =>
      call(at(selectors.sharingPickers), 'onChange', {
        mode: 'members',
        memberIds: ['user-1'],
        groupIds: [],
      }),
  },
];

for (const panel of lifecycleCases) {
  for (const outcome of ['pending', 'failure']) {
    test(`${panel.name}: ${outcome} does not invalidate`, async () => {
      hangFetch = outcome === 'pending';
      failFetch = outcome === 'failure';
      const sheet = mountSheet({ type: 'webhook', session_mode: 'keyed', model: 'openai/gpt-4' });
      await act(async () => panel.change(sheet));
      if (!panel.immediate) {
        expect(sheet.saveButtonOf(panel.section(sheet)).dirty).toBe(true);
        await act(async () => sheet.saveButtonOf(panel.section(sheet)).onSave());
      }
      const pending = () => {
        if (panel.name === 'Agent selection')
          return at(selectors.agentSelectors, selectors.agentSelectors.length - 1).disabled;
        if (panel.name === 'Model selection') {
          return at(sheet.buttonsWithin(panel.section(sheet), "Use the agent's usual model")).props
            .disabled;
        }
        return sheet.saveButtonOf(panel.section(sheet)).pending;
      };
      await sheet.flush();
      if (outcome === 'pending') {
        for (let i = 0; !pending() && i < 50; i++) await sheet.flush();
        expect(pending()).toBe(true);
        expect(toastCalls).toEqual([]);
      } else {
        expect(toastCalls.map((toast) => toast.kind)).toEqual(['error']);
        expect(at(toastCalls).message.length).toBeGreaterThan(0);
      }
      expect(calls).toHaveLength(1);
      expect(sheet.onMutated()).toBe(0);
      await act(async () => sheet.renderer.unmount());
    });
  }
}

describe('the header toggle', () => {
  test('pausing sends { enabled: false } and invalidates once', async () => {
    const sheet = mountSheet();
    const pause = sheet.buttonsWithin(null, 'Pause');
    expect(pause.length).toBe(1);
    await act(async () => call(at(pause, 0).props, 'onClick'));
    await sheet.flush();
    expectPatch({ enabled: false });
    expect(toastCalls.map((t) => t.kind)).toEqual(['success']);
    expect(sheet.onMutated()).toBe(1);
  });
});

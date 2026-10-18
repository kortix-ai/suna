/** Behavioral coverage of GeneralTab effort writes through the real SDK and
 * React Query. Only auth, IAM, routing, icon and DOM-only Select collaborators
 * are stubbed; the component under test is imported unchanged. */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix, type KortixProject } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, createElement } from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

import { PROJECT_ACTIONS } from '@/lib/project-actions';

function Passthrough({ children }: { children?: ReactNode }) {
  return createElement('div', null, children);
}

const realToast = await import('@/components/ui/toast');

// Reset transport and toast observations before each mount.
let calls: { url: string; method: string; body: unknown; status: number }[] = [];
let toastCalls: { kind: 'success' | 'error'; message: string }[] = [];
let canManage = true;
let canWriteProject = true;
let failWrite = false;
let releaseWrite: (() => void) | undefined;

mock.module('@/components/ui/toast', () => ({
  ...realToast,
  successToast: (message: string) => toastCalls.push({ kind: 'success', message }),
  errorToast: (message: string) => toastCalls.push({ kind: 'error', message }),
}));
// Collaborators, not the subject: the card reads `canManage` from the IAM
// probe, the container reads the session user and the router, and the icon
// field is a heavy picker that never opens in these tests.
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));
mock.module('@/lib/use-project-can', () => ({
  useProjectCans: () => ({
    [PROJECT_ACTIONS.PROJECT_WRITE]: { allowed: canWriteProject },
    [PROJECT_ACTIONS.PROJECT_SETTINGS_WRITE]: { allowed: canManage },
    [PROJECT_ACTIONS.PROJECT_DELETE]: { allowed: true },
  }),
}));
mock.module('@/features/projects/modal/project-icon-field', () => ({
  ProjectIconField: Passthrough,
}));

// Only the DOM-dependent Select primitives are replaced. Keep their value,
// disabled and onValueChange contract visible to the component test.
function EffortSelect(props: Record<string, unknown>) {
  return createElement('effort-select', props);
}
function EffortTrigger(props: Record<string, unknown>) {
  return createElement('effort-trigger', props);
}
function EffortItem(props: Record<string, unknown>) {
  return createElement('effort-item', props);
}
function EffortValue(props: Record<string, unknown>) {
  return createElement('effort-value', props);
}
mock.module('@/components/ui/select', () => ({
  Select: EffortSelect,
  SelectContent: Passthrough,
  SelectItem: EffortItem,
  SelectTrigger: EffortTrigger,
  SelectValue: EffortValue,
}));

const { GeneralTab } = await import('./general-tab');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const savedProject: KortixProject = {
  project_id: 'proj-1',
  account_id: 'acc-1',
  name: 'Triage',
  repo_url: 'https://github.com/acme/triage.git',
  default_branch: 'main',
  manifest_path: 'kortix.yaml',
  status: 'active',
  metadata: {},
  default_reasoning_effort: null,
  last_opened_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mounted: ReactTestRenderer[] = [];
const clients: QueryClient[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  calls = [];
  toastCalls = [];
  canManage = true;
  canWriteProject = true;
  failWrite = false;
  releaseWrite = undefined;
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init = {}) => {
      const path = String(url).split('?')[0];
      const method = init.method ?? 'GET';
      if (method === 'PUT' && path.endsWith('/projects/proj-1/default-reasoning-effort')) {
        const body = JSON.parse(String(init.body));
        calls.push({ url: path, method, body, status: failWrite ? 500 : 200 });
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
        return Response.json(
          failWrite ? { message: 'effort write failed' } : {
            ...savedProject, default_reasoning_effort: body.effort,
          },
          { status: failWrite ? 500 : 200 },
        );
      }
      if (method === 'GET' && path.endsWith('/projects/proj-1')) {
        return Response.json(savedProject);
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
  });
});

afterEach(async () => {
  await act(async () => {
    releaseWrite?.();
    await tick();
    for (const renderer of mounted.splice(0)) renderer.unmount();
  });
  for (const client of clients.splice(0)) client.clear();
});

async function mount(effort: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(qk.project.summary('proj-1'), {
    ...savedProject, default_reasoning_effort: effort,
  });
  clients.push(client);
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(QueryClientProvider, { client },
      createElement(GeneralTab, { projectId: 'proj-1' })));
    await tick();
  });
  mounted.push(renderer);
  return { client, renderer };
}

const picker = (renderer: ReactTestRenderer) => renderer.root.findByType(EffortSelect);
async function choose(renderer: ReactTestRenderer, value: string) {
  await act(async () => {
    picker(renderer).props.onValueChange(value);
    await tick();
  });
}
async function finishWrite() {
  await act(async () => {
    expect(releaseWrite).toBeDefined();
    releaseWrite!();
    await tick();
  });
}

describe('GeneralTab default reasoning effort', () => {
  test('an unset default selects Automatic first and renders the effort ladder', async () => {
    const { renderer } = await mount();
    expect(picker(renderer).props.value).toBe('');
    expect(picker(renderer).props.disabled).toBe(false);
    const options = renderer.root.findAllByType(EffortItem);
    expect(options.map((option) => option.props.value)).toEqual([
      '', 'none', 'low', 'medium', 'high', 'xhigh', 'max',
    ]);
    expect(options[0].props.children).toBe('Automatic');
    expect(renderer.root.findByType(EffortValue).props.placeholder).toBe('Automatic');
    // The trigger is named for assistive tech, not by its visible label alone.
    expect(renderer.root.findByType(EffortTrigger).props['aria-label']).toBe('Default reasoning effort');
    expect(calls).toEqual([]);
  });

  test('a settings writer without project.write can change effort', async () => {
    canWriteProject = false;
    const { renderer } = await mount();
    expect(picker(renderer).props.disabled).toBe(false);
    await choose(renderer, 'high');
    expect(calls).toHaveLength(1);
    await finishWrite();
  });

  test('a selection sends the exact SDK PUT, disables while pending, and repaints from summary cache', async () => {
    const { renderer, client } = await mount();
    await choose(renderer, 'high');
    expect(calls).toEqual([{
      url: 'http://api.test/v1/projects/proj-1/default-reasoning-effort',
      method: 'PUT', body: { effort: 'high' }, status: 200,
    }]);
    expect(picker(renderer).props.disabled).toBe(true);
    expect(picker(renderer).props.value).toBe('');
    await finishWrite();
    expect(client.getQueryData<KortixProject>(qk.project.summary('proj-1'))?.default_reasoning_effort).toBe('high');
    expect(picker(renderer).props.value).toBe('high');
    expect(picker(renderer).props.disabled).toBe(false);
    expect(toastCalls).toEqual([]);
  });

  test('Automatic clears a stored effort with null and repaints the picker', async () => {
    const { renderer, client } = await mount('max');
    expect(picker(renderer).props.value).toBe('max');
    await choose(renderer, '');
    expect(calls[0].body).toEqual({ effort: null });
    await finishWrite();
    expect(client.getQueryData<KortixProject>(qk.project.summary('proj-1'))?.default_reasoning_effort).toBeNull();
    expect(picker(renderer).props.value).toBe('');
  });

  test('a rejected write keeps the saved effort and reports one error', async () => {
    failWrite = true;
    const { renderer, client } = await mount('low');
    await choose(renderer, 'high');
    await finishWrite();
    expect(calls).toHaveLength(1);
    expect(picker(renderer).props.value).toBe('low');
    expect(picker(renderer).props.disabled).toBe(false);
    expect(client.getQueryData<KortixProject>(qk.project.summary('proj-1'))?.default_reasoning_effort).toBe('low');
    expect(toastCalls).toEqual([{ kind: 'error', message: 'effort write failed' }]);
  });

  test('a user without project.settings.write cannot use the effort control', async () => {
    canManage = false;
    const { renderer } = await mount('medium');
    expect(picker(renderer).props.disabled).toBe(true);
    expect(picker(renderer).props.value).toBe('medium');
    expect(calls).toEqual([]);
  });
});

/**
 * Regression (KRTX-2156): a FAILED repository-settings autosave must not
 * refire forever.
 *
 * `RepositoryGroup` autosaves `default_branch`/`manifest_path` from an effect
 * whose only guards are "the debounced values differ from the server values"
 * and "no save in flight". A failed save leaves the server values unchanged,
 * so on every `isPending` flip the effect re-runs, sees a difference, and
 * refires the same patch — an unbounded loop that error-toasts per attempt
 * for as long as the tab is open. (The flip only separates into its own
 * render when the PATCH takes a real network roundtrip, so the harness mock
 * waits one tick before answering; a same-macrotransaction reply batches the
 * two renders into one commit and hides the bug.)
 *
 * The fix remembers the patch the effect last attempted: the effect idles
 * while the input still holds it, a settled edit that differs from it is a
 * new edit, and a successful save clears the marker.
 *
 * Every assertion goes through the running component under
 * react-test-renderer, exactly like
 * `components/projects/schedule/schedule-detail-sheet.mutations.test.tsx`:
 * the real SDK transport (`updateProject` against a `configureKortix` fetch
 * override), the real `useDebounce` (real 500 ms settle), the real query
 * cache wiring — only the IAM probe, the Radix-tooltip hint and the toast
 * sink are stubbed. The manifest `Input` (`id="manifest-path"`) drives the
 * shared effect; the branch picker edits the same two-field patch through a
 * closed popover, so the input exercises both fields.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { configureKortix, type KortixProject, type ProjectDetail } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, createElement } from 'react';
import { type ReactTestRenderer, act, create } from 'react-test-renderer';

import { PROJECT_ACTIONS } from '@/lib/project-actions';

function Passthrough({ children }: { children?: ReactNode }) {
  return createElement('div', null, children);
}

const realToast = await import('@/components/ui/toast');

// Per-test state, REASSIGNED (not emptied) in `beforeEach`: a PATCH left in
// flight from an earlier test still holds this module's bindings, and its
// late push must land in the dead array, not in the next test's.
let calls: { url: string; method: string; body: unknown; status: number }[] = [];
let toastCalls: { kind: 'success' | 'error'; message: string }[] = [];
let failNextPatch = false;

const uiToastMock = () => ({
  ...realToast,
  successToast: (message: string) => toastCalls.push({ kind: 'success', message }),
  errorToast: (message: string) => toastCalls.push({ kind: 'error', message }),
});
mock.module('@/components/ui/toast', uiToastMock);
mock.module('@kortix/ui/toast', uiToastMock);
// The IAM probe is a collaborator, not the subject: the effect under test
// reads `canManage`, which this stub answers directly. `Hint` (a Radix
// tooltip, reached through `CopyButton`) needs a real DOM for its portal — a
// passthrough keeps the harness DOM-free.
const uiHintMock = () => ({ default: Passthrough });
mock.module('@/components/ui/hint', uiHintMock);
mock.module('@kortix/ui/hint', uiHintMock);
mock.module('@kortix/ui/shared/lib/use-deployment-cli-install-command', () => ({
  useDeploymentCliInstallCommand: () => 'install kortix',
}));
mock.module('@kortix/ui/shared/lib/use-project-can', () => ({
  useProjectCans: () => ({
    [PROJECT_ACTIONS.PROJECT_WRITE]: { allowed: true },
    [PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE]: { allowed: true },
  }),
}));

const { GitView } = await import('./git-view');

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
  last_opened_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const detail: ProjectDetail = {
  project: savedProject,
  git_connection: null,
  config: {
    is_kortix_repo: false,
    signals: {},
    manifest_raw: null,
    open_code_raw: null,
    open_code_default_agent: null,
    agent_discovery: 'opencode' as const,
    agents: [],
    skills: [],
    commands: [],
    env: { required: [], optional: [] },
  },
  file_count: 0,
  files: [],
};

const mountedRenderers: ReactTestRenderer[] = [];

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The latency a real PATCH has: without it the pending and settled renders
 *  batch into one commit and the `isPending` flip never re-runs the effect,
 *  which is the exact mechanism that drives the failed-save loop. */
const networkTick = () => settle(30);

/**
 * Wait out the real 500 ms debounce, then keep waiting in slices until no
 * new PATCH has landed for two consecutive slices — the mutation lifecycle
 * (pending render, network tick, callbacks, cache writes) fully drained.
 * Hard-capped so a live refire loop cannot hang the suite; the loop shows up
 * as a failed count assertion, not a timeout.
 */
async function flushDebounce() {
  let quietSlices = 0;
  for (let waited = 0; waited < 3000 && quietSlices < 2; waited += 100) {
    const before = calls.length;
    await act(async () => {
      await settle(100);
    });
    quietSlices = waited >= 500 && calls.length === before ? quietSlices + 1 : 0;
  }
}

beforeEach(() => {
  calls = [];
  toastCalls = [];
  failNextPatch = false;
  configureKortix({
    backendUrl: 'http://api.test/v1',
    getToken: async () => 'token',
    fetch: async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const path = String(url).split('?')[0];
      if (method === 'PATCH' && path.endsWith('/v1/projects/proj-1')) {
        await networkTick();
        const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
        const status = failNextPatch ? 500 : 200;
        calls.push({ url: path, method, body, status });
        if (failNextPatch) {
          return new Response(JSON.stringify({ message: 'upstream write failed' }), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ...savedProject, ...body }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'GET' && path.endsWith('/v1/projects/proj-1/detail')) {
        return new Response(JSON.stringify(detail), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'GET' && path.endsWith('/v1/projects/proj-1/branches')) {
        return new Response(JSON.stringify({ branches: [{ name: 'main' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
});

afterEach(async () => {
  act(() => {
    for (const r of mountedRenderers.splice(0)) r.unmount();
  });
  // Drain whatever outlived the tree (a debounce timer scheduled in the last
  // act, a PATCH still in flight): its callbacks land in an unmounted tree
  // and its pushes land in this test's dead arrays, never in the next test's.
  await act(async () => {
    await settle(600);
  });
});

const patches = () => calls.filter((c) => c.method === 'PATCH');

async function mountGitView() {
  const client = new QueryClient();
  client.setQueryData(qk.project.summary('proj-1'), savedProject);
  client.setQueryData(qk.project.detail('proj-1'), detail);
  let renderer!: ReactTestRenderer;
  // The mount's own queries round-trip inside this act scope, so their state
  // updates never land outside an act.
  await act(async () => {
    renderer = create(
      createElement(
        QueryClientProvider,
        { client },
        createElement(GitView, { projectId: 'proj-1' }),
      ),
    );
    await settle(50);
  });
  mountedRenderers.push(renderer);
  return { client, renderer };
}

/** Types into the manifest-path input: the same onChange the real surface runs. */
function typeManifest(renderer: ReactTestRenderer, value: string) {
  const input = renderer.root.findAll((node) => node.props.id === 'manifest-path')[0];
  if (!input) throw new Error('manifest-path input not found');
  act(() => {
    input.props.onChange({ target: { value } });
  });
}

describe('GitView repository-settings autosave: one attempt per edit', () => {
  test('a settled edit fires exactly one PATCH with both fields', async () => {
    const { renderer } = await mountGitView();
    await flushDebounce();

    typeManifest(renderer, 'k.yaml');
    await flushDebounce();

    expect(patches()).toEqual([
      {
        url: 'http://api.test/v1/projects/proj-1',
        method: 'PATCH',
        body: { default_branch: 'main', manifest_path: 'k.yaml' },
        status: 200,
      },
    ]);
  });

  test('a FAILED save fires once, toasts once, and never refires', async () => {
    failNextPatch = true;
    const { client, renderer } = await mountGitView();
    await flushDebounce();

    typeManifest(renderer, 'k.yaml');
    await flushDebounce();

    expect(patches().length).toBe(1);
    // The failure surfaces once — the loop used to re-toast per refire.
    expect(toastCalls.filter((c) => c.kind === 'error')).toHaveLength(1);
    // The server value is untouched: the cached project still holds the old path.
    expect(
      (client.getQueryData<KortixProject>(qk.project.summary('proj-1')) as KortixProject)
        .manifest_path,
    ).toBe('kortix.yaml');

    // Two more full debounce windows on the unchanged input: the bug refired
    // here on every `isPending` flip, forever.
    await flushDebounce();
    await flushDebounce();
    expect(patches().length).toBe(1);
  });

  test('after a failed save, a NEW settled edit fires exactly once more', async () => {
    failNextPatch = true;
    const { renderer } = await mountGitView();
    await flushDebounce();

    typeManifest(renderer, 'k.yaml');
    await flushDebounce();
    expect(patches().length).toBe(1);

    failNextPatch = false;
    typeManifest(renderer, 'k2.yaml');
    await flushDebounce();

    expect(patches()).toEqual([
      {
        url: 'http://api.test/v1/projects/proj-1',
        method: 'PATCH',
        body: { default_branch: 'main', manifest_path: 'k.yaml' },
        status: 500,
      },
      {
        url: 'http://api.test/v1/projects/proj-1',
        method: 'PATCH',
        body: { default_branch: 'main', manifest_path: 'k2.yaml' },
        status: 200,
      },
    ]);

    // And the successful save goes quiet again.
    await flushDebounce();
    expect(patches().length).toBe(2);
  });

  test('a SUCCESSFUL save writes through once and stays quiet', async () => {
    const { client, renderer } = await mountGitView();
    await flushDebounce();

    typeManifest(renderer, 'k.yaml');
    await flushDebounce();

    expect(patches().length).toBe(1);
    expect(
      (client.getQueryData<KortixProject>(qk.project.summary('proj-1')) as KortixProject)
        .manifest_path,
    ).toBe('k.yaml');
    expect(toastCalls).toEqual([]);

    await flushDebounce();
    await flushDebounce();
    expect(patches().length).toBe(1);
  });
});

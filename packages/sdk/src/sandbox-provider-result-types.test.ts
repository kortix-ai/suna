import { expect, test } from 'bun:test';
import type {
  KortixProject,
  PreparationView,
  SandboxProviderTransitionState,
  SandboxProviderTransitionView,
  UpdateProjectSandboxProviderResult,
} from './index';
// Value imports so `typeof` works — the functions are NEVER invoked (no network).
import { getProjectSandboxProviderTransition, updateProjectSandboxProvider } from './index';

// FIX-L: updateProjectSandboxProvider resolves to the exported tagged union
// (KortixProject-with-kind | PreparationView), keyed on `kind` — not a bare
// KortixProject. These are compile-time assertions; a regression (e.g. the return
// narrowed back to KortixProject) fails `tsc`, not just at runtime.
type UpdateReturn = Awaited<ReturnType<typeof updateProjectSandboxProvider>>;
type PollReturn = Awaited<ReturnType<typeof getProjectSandboxProviderTransition>>;

test('PATCH result is the exported kind-tagged union with PreparationView exported', () => {
  const prep: PreparationView = {
    kind: 'preparation',
    transition_id: 't1',
    project_id: 'p1',
    status: 'building',
    source_provider: 'daytona',
    target_provider: 'platinum',
    active_provider: 'daytona',
    label: 'Preparing Platinum',
    generation: 1,
    snapshot_name: 'img',
    external_template_id: 'tpl',
    commit_sha: 'abc',
    attempts: 0,
    last_error: null,
    error_class: null,
    requested_at: null,
    ready_at: null,
    activated_at: null,
    immediate: false,
  };

  // A PreparationView is a valid mutation result (the prepare branch), and the
  // declared return type is exactly the union.
  const asResult: UpdateProjectSandboxProviderResult = prep;
  const asDeclared: UpdateReturn = prep;
  expect(asResult.kind).toBe('preparation');
  expect(asDeclared.kind).toBe('preparation');

  // Narrowing on `kind` discriminates project vs preparation with no shape-sniff.
  const narrow = (r: UpdateProjectSandboxProviderResult): string => {
    if (r.kind === 'project') {
      const proj: KortixProject = r; // project branch carries the full KortixProject
      return proj.project_id;
    }
    const view: PreparationView = r; // preparation branch is a PreparationView
    return view.status;
  };
  expect(narrow(prep)).toBe('building');
});

test('the transition poll endpoint resolves to the public state shape', () => {
  const view: SandboxProviderTransitionView = {
    transition_id: 't1',
    project_id: 'p1',
    status: 'activated',
    source_provider: 'daytona',
    target_provider: 'platinum',
    generation: 2,
    label: 'Switched to Platinum',
    error_class: null,
    requested_at: null,
    ready_at: null,
    activated_at: null,
    immediate: false,
  };
  const state: SandboxProviderTransitionState = {
    active_provider: null,
    latest: view,
    history: [view],
  };
  const asDeclared: PollReturn = state;
  expect(asDeclared.latest?.status).toBe('activated');

  // The public view must NOT surface internal build/lease detail — these lines
  // fail to compile if the fields were part of the public type (the guarantee).
  // @ts-expect-error snapshot_name is internal and absent from the public view
  void view.snapshot_name;
  // @ts-expect-error last_error is internal and absent from the public view
  void view.last_error;
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Source-contract tests. `bun test` runs here without jsdom or RTL, so these
 * scan the source the way every sibling customize-section test does
 * (`settings-view.rename.test.tsx`, `channels-view.test.ts`) rather than
 * rendering. What they pin is behaviour a reviewer would otherwise have to
 * re-derive: which route the toggle calls, which permission leaf it gates on,
 * and that every stability value the API can serve has a rendering.
 */
const root = resolve(import.meta.dir, '../../../../..');
const source = readFileSync(join(import.meta.dir, 'feature-flags-view.tsx'), 'utf8');

describe('Feature flags section', () => {
  test('toggling calls the CANONICAL /features route through the SDK', () => {
    // `updateExperimentalFeature` still exists as a deprecated alias and still
    // hits `/experimental`. New UI must not use it.
    expect(source).toContain('updateFeatureFlag(workspaceId, flag.key, next)');
    expect(source).toContain("import {");
    expect(source).toContain('  updateFeatureFlag,');
    expect(source).not.toContain('updateExperimentalFeature');
  });

  test('the toggle gates on project.customize.write and fails closed while probing', () => {
    // The API asserts customize.write on PATCH /projects/:id/features. The old
    // home for this list gated on `manager || project.write` — wrong in both
    // directions.
    expect(source).toContain(
      'useWorkspaceCan(workspaceId, WORKSPACE_ACTIONS.WORKSPACE_CUSTOMIZE_WRITE)',
    );
    expect(source).toContain('const canWrite = !writeCap.isLoading && writeCap.allowed === true;');
    expect(source).toContain('disabled={!canWrite || mutation.isPending}');
    expect(source).not.toContain('WORKSPACE_ACTIONS.WORKSPACE_WRITE');
    expect(source).not.toContain("effective_workspace_role === 'manager'");
  });

  test('every stability the API can serve has a badge, including stable', () => {
    // FeatureFlagStabilitySchema = experimental | beta | stable. A missing arm
    // would render an unlabelled flag, not a compile error.
    expect(source).toContain("experimental: { label: 'Experimental', variant: 'highlight' },");
    expect(source).toContain("beta: { label: 'Beta', variant: 'beta' },");
    expect(source).toContain("stable: { label: 'Stable', variant: 'outline' },");
    expect(source).toContain('STABILITY_BADGE[flag.stability] ?? STABILITY_BADGE.experimental');
  });

  test('each row states whether it is a default or a workspace override', () => {
    expect(source).toContain("if (flag.overridden) return 'Overridden for this workspace';");
    expect(source).toContain("return flag.enabled ? 'Default on' : 'Default off';");
    expect(source).toContain('{originLabel(flag)}');
  });

  test('flags render in SERVER order and unavailable flags are not offered', () => {
    expect(source).toContain('(workspace?.experimental_features ?? []).filter((f) => f.available)');
    // Any client-side reordering would fight the registry's intentional order.
    expect(source).not.toContain('.sort(');
  });

  test('the Sandbox provider row moved here with the list', () => {
    expect(source).toContain('function SandboxProviderRow(');
    expect(source).toContain('updateWorkspaceSandboxProvider(workspace.workspace_id, next)');
    const settings = readFileSync(join(import.meta.dir, 'settings-view.tsx'), 'utf8');
    expect(settings).not.toContain('SandboxProviderRow');
    expect(settings).not.toContain('ExperimentalCard');
    expect(settings).not.toContain('experimental_features');
  });

  test('reads are consolidated onto the workspace DETAIL query', () => {
    // One entry backs the rail, `useFeatureFlag`, the palette, and this list —
    // so a single optimistic write lights every gated surface up together.
    expect(source).toContain('queryKey: qk.workspace.detail(workspaceId)');
    expect(source).toContain('queryFn: () => getWorkspaceDetail(workspaceId)');
    // The write still patches the summary entry: the PATCH response IS the
    // summary payload and settings-view renders off it.
    expect(source).toContain('queryClient.setQueryData(qk.workspace.summary(workspaceId), updated)');
    expect(source).toContain('qk.workspace.detail(workspaceId), (current)');
  });

  test('the llm_gateway toggle still refreshes provider state', () => {
    expect(source).toContain("if (flag.key === 'llm_gateway') {");
    expect(source).toContain(
      "refreshWorkspaceProviderState(queryClient, workspaceId, {\n          removeWorkspaceScopedCache: true,\n        })",
    );
  });

  test('optimistic switch position and an error toast are preserved', () => {
    expect(source).toContain('const [pendingValue, setPendingValue] = useState<boolean | null>');
    expect(source).toContain('checked={pendingValue ?? flag.enabled}');
    expect(source).toContain('onError: (error: Error) => errorToast(');
  });

  test('the section is registered everywhere a section must be registered', () => {
    const sections = readFileSync(join(root, 'lib/customize-sections.ts'), 'utf8');
    const actions = readFileSync(join(root, 'lib/workspace-actions.ts'), 'utf8');
    const rail = readFileSync(join(root, 'features/workspace/customize/rail.ts'), 'utf8');
    const panel = readFileSync(
      join(root, 'features/workspace/customize/customize-panel.tsx'),
      'utf8',
    );

    // Missing any one of these makes the section unreachable, or crashes the
    // rail's visibility lookup.
    expect(sections).toContain("| 'feature-flags'");
    expect(sections).toContain("'feature-flags',");
    expect(actions).toContain("'feature-flags': {");
    expect(rail).toContain("{ section: 'feature-flags', label: 'Feature flags', icon: FlagIcon }");
    expect(panel).toContain("case 'feature-flags':");
    expect(panel).toContain('<FeatureFlagsView workspaceId={workspaceId} />');
  });
});

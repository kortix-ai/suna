import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two claims this file guards, neither of which a runtime test can express.
 *
 *  1. **The probe layer lives in the SDK.** `usePermission` / `useProjectCan`
 *     used to be implemented here, against the repo rule that logic lives in
 *     `@kortix/sdk` — so `apps/whitelabel-demo` had no probe at all and fell
 *     back to reading a role literal off a row. These modules are now thin host
 *     bindings that inject the web auth provider's user id and nothing else.
 *
 *  2. **No gate reads a role label.** `effective_project_role === 'manager'` and
 *     the roster's `can_manage` flag are role labels by another name: a custom
 *     role granted the exact leaf a route asserts is invisible to both. Every
 *     one of those gates is now a probe.
 */

const SRC = join(import.meta.dir, '..');
const read = (relative: string) => readFileSync(join(SRC, relative), 'utf8');

/** Comments explaining what a gate USED to read are kept deliberately — they are
 *  the record of why the leaf is the leaf. Strip them before asserting a literal
 *  is gone from the code. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the probe layer is SDK-owned', () => {
  const binding = read('lib/use-permission.ts');
  const projectBinding = read('lib/use-project-can.ts');

  test('the hooks delegate to @kortix/sdk/react rather than reimplementing the query', () => {
    expect(binding).toContain("from '@kortix/sdk/react'");
    expect(binding).toContain('useCan as useSdkCan');
    // No react-query, no probe call: the host binds identity, the SDK queries.
    expect(binding).not.toContain('@tanstack/react-query');
    expect(binding).not.toContain('probeEffectivePermission');
    expect(projectBinding).not.toContain('@tanstack/react-query');
  });

  test('the host injects the signed-in user; the SDK never reaches for it', () => {
    expect(binding).toContain("useAuth } from '@/features/providers/auth-provider'");
    expect(binding).toContain('{ userId: user?.id }');
  });

  test('the cache contract is re-exported so a write path can reach it', () => {
    expect(binding).toContain('invalidatePermissionProbes');
  });
});

describe('no UI gate branches on a role label', () => {
  // file → the leaf it now probes. Each of these read
  // `effective_project_role === 'manager'` or the roster's `can_manage` flag.
  const CONVERTED: Array<[string, string]> = [
    ['features/workspace/settings/tabs/general-tab.tsx', 'PROJECT_DELETE'],
    ['features/workspace/settings/tabs/sandbox-tab.tsx', 'PROJECT_CUSTOMIZE_WRITE'],
    ['features/workspace/settings/tabs/snapshots-tab.tsx', 'PROJECT_CUSTOMIZE_WRITE'],
    ['features/workspace/customize/sections/view/git-view.tsx', 'PROJECT_WRITE'],
    ['components/projects/schedule-view.tsx', 'PROJECT_TRIGGER_UPDATE'],
    ['components/iam/access-projects-tab.tsx', 'PROJECT_MEMBERS_MANAGE'],
    // The "who can use it" grants moved from the agent detail aside to the
    // agent page's own section (Customize is agent-centric, 2026-09-01).
    ['features/workspace/capabilities/agents/agent-people-section.tsx', 'PROJECT_MEMBERS_MANAGE'],
    ['features/workspace/customize/sections/view/secrets-view.tsx', 'PROJECT_SECRET_WRITE'],
  ];

  for (const [file, action] of CONVERTED) {
    test(`${file} probes PROJECT_ACTIONS.${action}`, () => {
      const source = read(file);
      expect(source).toContain(`PROJECT_ACTIONS.${action}`);
      expect(source).toMatch(/useProjectCans?\(/);
    });
  }

  test('the manager literal is gone from the CODE of every one of them', () => {
    for (const [file] of CONVERTED) {
      // Comments explaining what the gate used to be are kept on purpose.
      const code = stripComments(read(file));
      expect({ file, hit: code.includes("effective_project_role === 'manager'") }).toEqual({
        file,
        hit: false,
      });
    }
  });

  test('the roster can_manage flag no longer gates a control', () => {
    for (const file of [
      'features/workspace/capabilities/agents/agent-detail-aside.tsx',
      'features/workspace/capabilities/agents/agent-people-section.tsx',
      'features/workspace/customize/sections/view/channels-view.tsx',
      'features/workspace/customize/sections/view/secrets-view.tsx',
    ]) {
      const code = stripComments(read(file)).replace(/can_manage_\w+/g, '');
      expect({ file, hit: /can_manage\b/.test(code) }).toEqual({ file, hit: false });
    }
  });

  test('the project card fails CLOSED — it was the one gate that failed open', () => {
    const source = read('features/projects/project-card.tsx');
    // `role === 'manager' || !role` enabled Edit and Archive for every viewer
    // whose row simply carried no role — including a row that carried none
    // because the field was absent.
    expect(source).not.toContain('|| !project.effective_project_role');
    expect(source).not.toContain("effective_project_role === 'manager'");
    // The answers arrive as props (one batched probe per list, not per card) and
    // both default to false.
    expect(source).toContain('canEdit = false');
    expect(source).toContain('canArchive = false');
    expect(source).toContain('PROJECT_CARD_ACTIONS');
  });

  test('the attach-to-project picker asks the engine which projects qualify', () => {
    const dialog = read('features/workspace/shared/access/access-dialog.tsx');
    const select = read('features/workspace/shared/access/project-select.tsx');
    expect(dialog).toContain('requireAction={PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE}');
    // ONE batched probe covers every candidate project, not one request per row.
    expect(select).toContain('requireAction');
    expect(select).toContain('usePermissions(accountId, probes)');
    expect(select).not.toContain("effective_project_role === 'manager'");
  });
});

describe('every access write busts the probe cache', () => {
  // Probe verdicts are cached 5 minutes. Before this, exactly ONE site in the
  // product invalidated them (`mfa-required-card.tsx`), so a revoke rendered as
  // access for up to five minutes.
  const WRITE_SURFACES = [
    'features/workspace/shared/access/access-dialog.tsx',
    'components/iam/member-access-panel.tsx',
    'components/iam/group-access-panel.tsx',
    'components/iam/access-projects-tab.tsx',
    'components/iam/roles-tab.tsx',
    'components/iam/groups-tab.tsx',
    'app/(app)/accounts/[id]/page.tsx',
  ];

  for (const file of WRITE_SURFACES) {
    test(`${file} calls invalidatePermissionProbes`, () => {
      expect(read(file)).toContain('invalidatePermissionProbes(queryClient');
    });
  }
});

describe('the client no longer mirrors the permission catalog', () => {
  const matrix = read('components/iam/role-capability-matrix.tsx');
  const panel = read('components/iam/member-access-panel.tsx');

  test('areas, levels and implications come from the catalog', () => {
    expect(matrix).toContain('export function buildAreaTable(');
    expect(matrix).toContain('export function buildImplications(');
    expect(matrix).toContain('entry.implies');
    // The hardcoded tables and the client-invented implication graph are gone.
    expect(matrix).not.toContain('const PROJECT_AREAS');
    expect(matrix).not.toContain('const ACCOUNT_AREAS');
    expect(matrix).not.toContain('EXTRA_IMPLICATIONS: Record');
  });

  test('the member capability panels read the catalog too', () => {
    expect(panel).toContain('listPermissions(');
    // Two hand-curated arrays that disagreed with each other and the server.
    expect(panel).not.toContain('const CAPABILITY_GROUPS');
    expect(panel).not.toContain('const SIMULATOR_PROBES');
    // `audit.export` lived only in the simulator and is not a permission at all.
    expect(panel).not.toContain('audit.export');
  });
});

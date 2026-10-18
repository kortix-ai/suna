// The one Customize access rule (`capabilityAccess`), which the sidebar row,
// the More menu, the tab bar, the page-body gate, the `/customize` redirect
// and the command palette all read. KRTX-2144: a limited project member saw
// tabs that dead-ended in "You don't have access", saw a different set on the
// next visit, and still saw Customize and trigger configuration.
import { describe, expect, test } from 'bun:test';

import {
  CAPABILITY_TAB_ACTIONS,
  capabilityAccess,
  projectNavRows,
} from '@/features/workspace/project-sidebar/project-settings-nav';
import { filesRow } from '@/features/workspace/project-sidebar/footer/files-nav-label';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { PROJECT_PAGE_ACTIONS, type CanResult } from '@/lib/use-project-can';

const verdict = (allowed: boolean): CanResult => ({
  allowed,
  reason: null,
  isLoading: false,
  isError: false,
});
const inFlight: CanResult = { allowed: false, reason: null, isLoading: true, isError: false };
const failed: CanResult = { allowed: false, reason: null, isLoading: false, isError: true };

/** Probe map for a caller allowed exactly the listed actions. */
const allowOnly = (...allowed: string[]) =>
  Object.fromEntries(PROJECT_PAGE_ACTIONS.map((a) => [a, verdict(allowed.includes(a))]));
const every = (result: CanResult) => Object.fromEntries(PROJECT_PAGE_ACTIONS.map((a) => [a, result]));
/** The rule for a project with the `drives` flag on. */
const access = (caps: Record<string, CanResult>) => capabilityAccess(caps, true);

// The built-in Member role's project leaves
// (packages/db/migrations/20260819015724479_rbac_canonical_model.sql).
const MEMBER = [
  PROJECT_ACTIONS.PROJECT_READ,
  PROJECT_ACTIONS.PROJECT_AGENT_READ,
  PROJECT_ACTIONS.PROJECT_MEMBERS_READ,
  PROJECT_ACTIONS.PROJECT_REVIEW_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
  PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE,
];

describe('capabilityAccess', () => {
  test('a manager opens every tab, in bar order', () => {
    expect(capabilityAccess(every(verdict(true)), true)).toEqual({
      settled: true,
      tabs: [
        'agent',
        'skills',
        'connectors',
        'triggers',
        'models',
        'secrets',
        'files',
        'config',
      ],
    });
  });

  test('a plain member opens only Files: no Agents, no Triggers, no dead-end tab', () => {
    expect(access(allowOnly(...MEMBER))).toEqual({ settled: true, tabs: ['files'] });
  });

  test('Review is absent from Customize even when the caller can act', () => {
    const read = PROJECT_ACTIONS.PROJECT_REVIEW_READ;
    expect(access(allowOnly(read)).tabs).toEqual([]);
    expect(access(allowOnly(read, PROJECT_ACTIONS.PROJECT_REVIEW_ACT)).tabs).toEqual([]);
  });

  test('a caller without project.read gets no tab, so no Customize row', () => {
    expect(access(allowOnly()).tabs).toEqual([]);
  });

  test('a read leaf alone does not show a configuration tab', () => {
    const tabs = access(
      allowOnly(
        PROJECT_ACTIONS.PROJECT_AGENT_READ,
        PROJECT_ACTIONS.PROJECT_SKILL_READ,
        PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
        PROJECT_ACTIONS.PROJECT_TRIGGER_READ,
        PROJECT_ACTIONS.PROJECT_MODEL_READ,
        PROJECT_ACTIONS.PROJECT_SECRET_READ,
      ),
    ).tabs;
    expect(tabs).toEqual([]);
  });

  test('a write leaf without its read leaf does not show the tab', () => {
    expect(access(allowOnly(PROJECT_ACTIONS.PROJECT_SECRET_WRITE)).tabs).toEqual([]);
  });

  test('any one trigger write leaf shows Triggers; firing alone does not', () => {
    for (const write of [
      PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE,
      PROJECT_ACTIONS.PROJECT_TRIGGER_DELETE,
    ]) {
      expect(access(allowOnly(PROJECT_ACTIONS.PROJECT_TRIGGER_READ, write)).tabs).toEqual([
        'triggers',
      ]);
    }
    expect(
      access(
        allowOnly(PROJECT_ACTIONS.PROJECT_TRIGGER_READ, PROJECT_ACTIONS.PROJECT_TRIGGER_FIRE),
      ).tabs,
    ).toEqual([]);
  });

  test('managing personal connections shows Connectors', () => {
    expect(
      access(
        allowOnly(
          PROJECT_ACTIONS.PROJECT_CONNECTOR_READ,
          PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
        ),
      ).tabs,
    ).toEqual(['connectors']);
  });

  // Nothing acts on a half answer: that is what showed a section on one
  // visit and hid it on the next.
  test('one probe in flight means not settled and no tab', () => {
    const caps = every(verdict(true));
    caps[PROJECT_ACTIONS.PROJECT_SECRET_WRITE] = inFlight;
    expect(access(caps)).toEqual({ settled: false, tabs: [] });
    expect(access({})).toEqual({ settled: false, tabs: [] });
  });

  test('Files shows only with the drives flag on, and waits for the flag', () => {
    const member = allowOnly(...MEMBER);
    expect(capabilityAccess(member, false)).toEqual({ settled: true, tabs: [] });
    expect(capabilityAccess(member, undefined)).toEqual({ settled: false, tabs: [] });
  });

  test('a failed probe settles closed', () => {
    expect(access(every(failed))).toEqual({ settled: true, tabs: [] });
  });

  test('the shared page batch carries every leaf the rule reads', () => {
    const batch: readonly string[] = PROJECT_PAGE_ACTIONS;
    for (const action of CAPABILITY_TAB_ACTIONS) expect(batch).toContain(action);
  });
});

// The sidebar's Files and Customize rows, decided together: a plain member
// reaches their shared folders from the Files row, never from a Customize row
// that holds Files alone.
describe('projectNavRows', () => {
  const READ_REPO = PROJECT_ACTIONS.PROJECT_FILE_READ;
  const rows = (caps: Record<string, CanResult>, drives: boolean | undefined = true) =>
    projectNavRows(capabilityAccess(caps, drives), caps[READ_REPO], caps[PROJECT_ACTIONS.PROJECT_REVIEW_READ], caps[PROJECT_ACTIONS.PROJECT_REVIEW_ACT]);

  test('a plain member with drives on gets a Files row to the folders and no Customize row', () => {
    expect(rows(allowOnly(...MEMBER))).toEqual({ customize: null, files: 'folders' });
  });

  test('a plain member with drives off gets neither row', () => {
    expect(rows(allowOnly(...MEMBER), false)).toEqual({ customize: null, files: null });
  });

  test('a repo reader keeps the repo row, and Files stays a Customize tab', () => {
    expect(rows(allowOnly(...MEMBER, READ_REPO))).toEqual({ customize: 'files', files: 'repo' });
  });

  test('a manager lands Customize on its first tab and Files on the repo', () => {
    expect(rows(every(verdict(true)))).toEqual({ customize: 'agent', files: 'repo' });
  });

  test('a member who configures something lands Customize past Files', () => {
    const caps = allowOnly(
      ...MEMBER,
      PROJECT_ACTIONS.PROJECT_SECRET_READ,
      PROJECT_ACTIONS.PROJECT_SECRET_WRITE,
    );
    expect(rows(caps)).toEqual({ customize: 'secrets', files: 'folders' });
  });

  test('nothing shows while the batch or the flag is in flight', () => {
    const caps = allowOnly(...MEMBER, READ_REPO);
    caps[READ_REPO] = inFlight;
    expect(rows(caps)).toEqual({ customize: null, files: null });
    const settledCaps = allowOnly(...MEMBER, READ_REPO);
    expect(projectNavRows(capabilityAccess(settledCaps, undefined), settledCaps[READ_REPO])).toEqual(
      { customize: null, files: null },
    );
    expect(rows({})).toEqual({ customize: null, files: null });
  });
});


describe('Repo Review navigation permissions', () => {
  const settled = { settled: true, tabs: [] } as const;
  const nav = (repo: CanResult, read?: CanResult, act?: CanResult) =>
    projectNavRows({ ...settled, tabs: [] }, repo, read, act);

  test('review actors without repo access land directly on Review', () => {
    expect(nav(verdict(false), verdict(true), verdict(true))).toEqual({ customize: null, files: 'review' });
  });

  test('Review destination uses the shared Repo/Files label and folders stay under Customize', () => {
    expect(filesRow('synthetic-project', 'review', true)).toEqual({ label: 'repo', href: '/projects/synthetic-project/files/review' });
    expect(filesRow('synthetic-project', 'review', false).label).toBe('files');
    expect(filesRow('synthetic-project', 'folders', true).href).toBe('/projects/synthetic-project/customize/files');
  });

  test('repo readers retain the repo destination with or without Review', () => {
    expect(nav(verdict(true), verdict(true), verdict(true)).files).toBe('repo');
    expect(nav(verdict(true), verdict(false), verdict(false)).files).toBe('repo');
  });

  test('read alone, act alone, and errors do not grant Review', () => {
    for (const [read, act] of [[verdict(true), verdict(false)], [verdict(false), verdict(true)], [failed, verdict(true)], [verdict(true), failed], [{ ...failed, allowed: true }, verdict(true)]]) {
      expect(nav(verdict(false), read, act).files).toBeNull();
    }
  });

  test('provided Review probes must both settle before either row appears', () => {
    for (const [read, act] of [[inFlight, verdict(true)], [verdict(true), inFlight], [verdict(true), undefined], [undefined, verdict(true)]]) {
      expect(nav(verdict(true), read, act)).toEqual({ customize: null, files: null });
    }
  });

  test('omitted optional probes preserve the trunk folders fallback', () => {
    expect(projectNavRows({ settled: true, tabs: ['files'] }, verdict(false))).toEqual({ customize: null, files: 'folders' });
  });
});

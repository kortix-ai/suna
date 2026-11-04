// KRTX-4038: pins what a goal row's second line reads (its `detail`, then who
// it is for) on the real Goals page, so the row's display rules can move into
// helpers without changing a word. The page renders from a seeded query cache:
// no fetch, synthetic goals only.
import { describe, expect, test } from 'bun:test';
import type { ProjectGoal, ProjectGoalDocument } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { UiProvider } from '@kortix/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';

import { GoalsPage } from './goals-page';

const PROJECT = '00000000-0000-4000-8000-0000000000aa';
const ACCOUNT = '00000000-0000-4000-8000-0000000000bb';
const VIEWER = '11111111-1111-4111-8111-111111111111';
const TEAMMATE = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const useViewerId = () => VIEWER;

function doc(overrides: Partial<ProjectGoalDocument>): ProjectGoalDocument {
  return {
    version: 1,
    objective: 'Synthetic goal',
    status: 'active',
    summary: '',
    success_criteria: [],
    items: [],
    sessions: [],
    reminder_id: null,
    transitions: [],
    verified_by: null,
    next_wake_at: null,
    ...overrides,
  };
}

function goal(slug: string, overrides: Partial<ProjectGoal> & { doc?: Partial<ProjectGoalDocument> }): ProjectGoal {
  const { doc: docOverrides, ...rest } = overrides;
  return {
    slug,
    scope: 'company',
    driveId: 'drive',
    folder: `/Company/Goals/${slug}`,
    goal: doc({ objective: slug, ...docOverrides }),
    heartbeat: null,
    coordinatorSessionId: null,
    health: { state: 'healthy', issues: [] },
    ...rest,
  };
}

/** The second line of every goal row on the page, keyed by the row's objective. */
function rowLines(goals: ProjectGoal[]): Record<string, string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.project.goals(PROJECT), goals);
  client.setQueryData(qk.project.summary(PROJECT), { account_id: ACCOUNT });
  client.setQueryData(['account-members', ACCOUNT], [{ user_id: TEAMMATE, email: 'teammate@example.test' }]);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <UiProvider useViewerId={useViewerId}>
        <GoalsPage projectId={PROJECT} />
      </UiProvider>
    </QueryClientProvider>,
  );
  const lines: Record<string, string> = {};
  for (const match of html.matchAll(
    /data-testid="goal-row".*?<span class="text-foreground truncate text-sm">([^<]*)<\/span><span class="text-muted-foreground truncate text-xs">([^<]*)<\/span>/g,
  )) {
    lines[match[1]!] = match[2]!.replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
  }
  return lines;
}

describe('goal row second line', () => {
  test('detail: the first health issue, then the waiting question, the open ask, the closed summary, the next wake, else no wake', () => {
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const lines = rowLines([
      goal('issue', { health: { state: 'attention', issues: ['heartbeat_paused'] }, doc: { waiting_on: 'ignored' } }),
      goal('waiting', { doc: { status: 'waiting_on_user', waiting_on: 'Pick a launch date' } }),
      goal('ask', {
        doc: { items: [{ id: 'a1', kind: 'ask', title: 'Approve the budget', status: 'open', owner: 'user' }] as ProjectGoalDocument['items'] },
      }),
      goal('closed-summary', { health: { state: 'closed', issues: [] }, doc: { status: 'done', summary: 'Shipped in v2' } }),
      goal('closed-plain', { health: { state: 'closed', issues: [] }, doc: { status: 'abandoned' } }),
      goal('next-wake', {
        heartbeat: { next_fire_at: later } as ProjectGoal['heartbeat'],
      }),
      goal('no-wake', {}),
    ]);
    expect(lines['issue']).toBe('The heartbeat loop is paused.');
    expect(lines['waiting']).toBe('Waiting for: Pick a launch date');
    expect(lines['ask']).toBe('Waiting for: Approve the budget');
    expect(lines['closed-summary']).toBe('Shipped in v2');
    expect(lines['closed-plain']).toBe('Abandoned');
    expect(lines['next-wake']).toStartWith('Next wake ');
    expect(lines['no-wake']).toBe('No wake scheduled');
  });

  test('who: the agent, then for you, for a named teammate, or for an unknown teammate', () => {
    const lines = rowLines([
      goal('agent-only', { doc: { agent: 'builder' } }),
      goal('for-viewer', { doc: { assigned_user: VIEWER } }),
      goal('for-teammate', { doc: { agent: 'builder', assigned_user: TEAMMATE } }),
      goal('for-stranger', { doc: { assigned_user: STRANGER } }),
    ]);
    expect(lines['agent-only']).toBe('No wake scheduled · builder');
    expect(lines['for-viewer']).toBe('No wake scheduled · for you');
    expect(lines['for-teammate']).toBe('No wake scheduled · builder · for teammate@example.test');
    expect(lines['for-stranger']).toBe('No wake scheduled · for a teammate');
  });
});

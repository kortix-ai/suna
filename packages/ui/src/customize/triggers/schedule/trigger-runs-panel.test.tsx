import type { ProjectTrigger, ProjectTriggerRun } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RunRow } from './trigger-runs-panel';

const trigger = { slug: 'triage', type: 'webhook' } as ProjectTrigger;
const failed = {
  run_id: 'run-1',
  slug: 'triage',
  source: 'webhook',
  status: 'failed',
  run_status: null,
  error: 'github.add_labels returned 403',
  run_error: null,
  session_id: 'ses_example',
  command_id: null,
  replay_of: null,
  payload_verified: true,
  payload: { body: { action: 'opened' } },
  scheduled_for: '2026-10-17T10:30:02.000Z',
  created_at: '2026-10-17T10:30:02.000Z',
  started_at: '2026-10-17T10:30:02.000Z',
  ended_at: '2026-10-17T10:30:08.000Z',
  duration_ms: 6000,
  cost_usd: 0.01,
} as ProjectTriggerRun;
const replay = { pending: false, disabled: false, onReplay: () => {} };

const render = (props: Partial<Parameters<typeof RunRow>[0]> = {}) =>
  renderToStaticMarkup(
    <ul>
      <RunRow
        projectId="p1"
        trigger={trigger}
        run={failed}
        newDay={false}
        replay={replay}
        {...props}
      />
    </ul>,
  );

describe('RunRow (C20 D6V-0 + D73-0)', () => {
  test('collapsed: a toggle, not a link; the error on the line; Replay on hover', () => {
    const out = render();
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('href=');
    expect(out).toContain('github.add_labels returned 403');
    expect(out).toContain('group-hover:opacity-100');
    expect(out).toContain('Replay');
  });

  test('expanded: meta, Replay (outline), Open session as a link, the payload; no hover Replay', () => {
    const out = render({ initialOpen: true });
    expect(out).toContain('aria-expanded="true"');
    expect(out).toContain('href="/projects/p1/sessions/ses_example"');
    expect(out).toContain('Open session');
    expect(out).toContain('ses_example');
    expect(out).toContain('&quot;action&quot;: &quot;opened&quot;');
    expect(out).not.toContain('group-hover:opacity-100');
  });

  test('a run that may not be replayed offers no Replay', () => {
    expect(render({ replay: null })).not.toContain('>Replay<');
  });
});

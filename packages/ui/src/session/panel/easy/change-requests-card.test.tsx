import { afterAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import type { ChangeRequest } from '@kortix/sdk';
import { ChangeRequestsCard } from './change-requests-card';

function request(number: number, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    cr_id: `cr_${number}`, number, title: `Proposal ${number}`, description: '',
    account_id: 'account_test', project_id: 'project_test', base_ref: 'dev', head_ref: `branch_${number}`,
    status: 'open', head_commit_sha: null, base_commit_sha: null, origin_session_id: 'session_test',
    created_by: 'agent_test', merged_at: null, merged_by: null, merge_commit_sha: null,
    closed_at: null, closed_by: null, metadata: {},
    created_at: `2026-10-${String(number).padStart(2, '0')}T12:00:00Z`, updated_at: '2026-10-24T12:00:00Z',
    ...overrides,
  };
}
const previousWindow = globalThis.window;
const previousDocument = globalThis.document;
const testWindow = new Window();
Object.defineProperty(globalThis, 'document', { value: testWindow.document, configurable: true });
Object.defineProperty(globalThis, 'window', { value: testWindow, configurable: true });
afterAll(() => {
  Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
  Object.defineProperty(globalThis, 'document', { value: previousDocument, configurable: true });
});
const noop = () => {};
const jump = async () => {};

describe('ChangeRequestsCard', () => {
  test('empty sessions render nothing', () => {
    expect(renderToStaticMarkup(<ChangeRequestsCard requests={[]} onOpen={noop} onJump={jump} />)).toBe('');
  });

  test('newest first, with references, ages and the header count', () => {
    const html = renderToStaticMarkup(<ChangeRequestsCard requests={[request(1), request(3), request(2)]} onOpen={noop} onJump={jump} />);
    expect(html.indexOf('Proposal 3')).toBeLessThan(html.indexOf('Proposal 2'));
    expect(html.indexOf('Proposal 2')).toBeLessThan(html.indexOf('Proposal 1'));
    expect(html).toContain('Change requests');
    expect(html).toContain('#3');
    expect(html).toContain('<time');
    expect(html).toContain('>3</span>');
  });

  test('open, merged, closed and superseded requests show their current status', () => {
    const html = renderToStaticMarkup(<ChangeRequestsCard requests={[
      request(1), request(2, { status: 'merged' }), request(3, { status: 'closed' }),
      request(4, { status: 'closed', superseded_by: { cr_id: 'cr_5', number: 5 } }),
    ]} onOpen={noop} onJump={jump} />);
    for (const label of ['Open', 'Applied', 'Dismissed', 'Superseded by #5']) expect(html).toContain(label);
  });

  test('opening and jumping use the clicked request, including a superseded request', async () => {
    const opened: string[] = [];
    const jumped: string[] = [];
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => { renderer = create(<ChangeRequestsCard
      requests={[request(1), request(2, { status: 'closed', superseded_by: { cr_id: 'cr_3', number: 3 } })]}
      onOpen={(id) => opened.push(id)} onJump={async (id) => { jumped.push(id); }}
    />); });
    if (!renderer) throw new Error('Card did not mount');
    const buttons = renderer.root.findAllByType('button');
    await act(async () => { buttons.find((button) => button.props['data-cr-id'] === 'cr_2')?.props.onClick(); });
    await act(async () => { await buttons.find((button) => button.props['aria-label'] === 'Jump to response for #1')?.props.onClick(); });
    expect(opened).toEqual(['cr_2']);
    expect(jumped).toEqual(['cr_1']);
    await act(async () => renderer?.unmount());
  });
});

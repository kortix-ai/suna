import { describe, expect, test } from 'bun:test';
import type { ChangeRequest } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';

import { ChangeRequestStatusBadge } from './change-request-status-badge';

// KRTX-3031: the dialog of a request an agent replaced read only "Dismissed".
function cr(over: Partial<ChangeRequest>): ChangeRequest {
  return {
    cr_id: 'cr_12',
    number: 12,
    title: 'Store page',
    status: 'closed',
    superseded_by: null,
    ...over,
  } as ChangeRequest;
}

describe('ChangeRequestStatusBadge', () => {
  test('a superseded request names its replacement as a button that opens it', async () => {
    const opened: string[] = [];
    const replaced = cr({ superseded_by: { cr_id: 'cr_13', number: 13 } });

    const html = renderToStaticMarkup(
      <ChangeRequestStatusBadge cr={replaced} onOpenChangeRequest={(id) => opened.push(id)} />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('Superseded by #13');

    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(<ChangeRequestStatusBadge cr={replaced} onOpenChangeRequest={(id) => opened.push(id)} />);
    });
    await act(async () => {
      renderer!.root.findByType('button').props.onClick();
    });
    expect(opened).toEqual(['cr_13']);
  });

  test('without a way to open it, the replacement is still named, as plain text', () => {
    const html = renderToStaticMarkup(
      <ChangeRequestStatusBadge cr={cr({ superseded_by: { cr_id: 'cr_13', number: 13 } })} />,
    );
    expect(html).toContain('Superseded by #13');
    expect(html).not.toContain('<button');
  });

  test('closed for another reason reads "Dismissed", applied reads "Applied", open shows nothing', () => {
    expect(renderToStaticMarkup(<ChangeRequestStatusBadge cr={cr({})} />)).toContain('Dismissed');
    expect(renderToStaticMarkup(<ChangeRequestStatusBadge cr={cr({ status: 'merged' })} />)).toContain('Applied');
    expect(renderToStaticMarkup(<ChangeRequestStatusBadge cr={cr({ status: 'open' })} />)).toBe('');
  });
});

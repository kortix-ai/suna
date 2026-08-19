import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueuedMessages } from './queued-messages';

/**
 * What the strip does with a row that is ON THE WIRE.
 *
 * It used to filter those rows out before any render decision, which was
 * correct while "on the wire" meant milliseconds: the row left the queue and
 * arrived in the transcript. It no longer does. A prompt typed mid-turn is
 * forwarded at once and reads `delivering` until the turn in front of it ends —
 * minutes, sometimes an hour — and nothing paints it into the transcript in the
 * meantime. Filtering it out is the user's message disappearing.
 *
 * So it RENDERS, and it renders INERT: no edit, no remove, no send-now, no drag
 * handle. Every one of those actions is refused by the server for a row it has
 * already forwarded.
 *
 * `renderToStaticMarkup` + real markup assertions, the same shell as
 * `composer-toolbar.test.tsx`.
 */

const noop = () => {};

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('QueuedMessages — a row on the wire', () => {
  test('renders its text instead of vanishing from the strip', () => {
    const markup = render(
      <QueuedMessages
        messages={[{ id: 'a', text: 'the message I typed mid-turn' }]}
        inFlightIds={['a']}
        onRemove={noop}
        onEdit={noop}
        onSendNow={noop}
        paused
      />,
    );

    expect(markup).toContain('the message I typed mid-turn');
  });

  test('offers none of the actions the server would refuse', () => {
    const markup = render(
      <QueuedMessages
        messages={[{ id: 'a', text: 'on the wire' }]}
        inFlightIds={['a']}
        onRemove={noop}
        onEdit={noop}
        onReorder={noop}
        onSendNow={noop}
        paused
      />,
    );

    expect(markup).not.toContain('Remove from queue');
    expect(markup).not.toContain('Edit message');
    expect(markup).not.toContain('Send now');
    expect(markup).not.toContain('Reorder message');
  });

  test('a QUEUED row beside it keeps every action', () => {
    // The control group: the inertness above is about the in-flight row, not
    // about the strip forgetting how to offer actions.
    const markup = render(
      <QueuedMessages
        messages={[
          { id: 'a', text: 'on the wire' },
          { id: 'b', text: 'still mine' },
        ]}
        inFlightIds={['a']}
        onRemove={noop}
        onEdit={noop}
        onReorder={noop}
        onSendNow={noop}
        paused
      />,
    );

    expect(markup).toContain('Remove from queue');
    expect(markup).toContain('Send now');
  });

  test('an empty list still renders nothing at all', () => {
    // The `:empty` check the composer's strip relies on to disappear: a shell
    // painted around zero rows is the "phantom sliver above the composer".
    expect(render(<QueuedMessages messages={[]} />)).toBe('');
  });
});

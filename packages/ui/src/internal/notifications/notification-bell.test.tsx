import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BellMark } from './notification-bell';

describe('BellMark', () => {
  test('no unread: the bell alone, no count', () => {
    expect(renderToStaticMarkup(<BellMark count={0} needsYou={false} />)).not.toContain('bell-count');
  });

  test('the count sits in a blue disc, yellow when something needs the person, clamped at 99+', () => {
    const blue = renderToStaticMarkup(<BellMark count={3} needsYou={false} />);
    expect(blue).toContain('bg-kortix-blue');
    expect(blue).toContain('>3<');
    const yellow = renderToStaticMarkup(<BellMark count={120} needsYou />);
    expect(yellow).toContain('bg-kortix-yellow');
    expect(yellow).toContain('>99+<');
  });
});

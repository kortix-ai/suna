import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AppearanceTabView } from './appearance-tab';

/** The opening tags of every switch on the pane. Scoped to `role="switch"`
 *  because the density cards also carry `aria-checked`. */
const switches = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);

describe('Appearance: rich answers', () => {
  test('renders one labelled switch that reflects the preference', () => {
    const on = renderToStaticMarkup(<AppearanceTabView genuiEnabled />);
    expect(on).toContain('>Rich answers</h3>');
    expect(switches(on)).toHaveLength(1);
    expect(switches(on)[0]).toContain('aria-label="Rich answers"');
    expect(switches(on)[0]).toContain('aria-checked="true"');

    const off = renderToStaticMarkup(<AppearanceTabView genuiEnabled={false} />);
    expect(switches(off)[0]).toContain('aria-checked="false"');
  });

  test('is on when the preference is unset', () => {
    expect(switches(renderToStaticMarkup(<AppearanceTabView />))[0]).toContain(
      'aria-checked="true"',
    );
  });
});

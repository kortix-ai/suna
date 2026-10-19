import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  test('passes its attributes to the element', () => {
    // It used to drop everything but `className` and `children`: a caller's
    // `style` (a width, an animation delay) or `data-*` hook never arrived.
    const html = renderToStaticMarkup(
      <Skeleton
        className="h-3.5"
        style={{ animationDelay: '-400ms' }}
        data-slot="row-skeleton"
        aria-hidden
      />,
    );
    expect(html).toContain('animation-delay:-400ms');
    expect(html).toContain('data-slot="row-skeleton"');
    expect(html).toContain('aria-hidden="true"');
  });

  test('keeps its own look and adds the caller classes', () => {
    const html = renderToStaticMarkup(<Skeleton className="h-3.5 w-1/2" />);
    expect(html).toContain('bg-primary/10');
    expect(html).toContain('animate-pulse');
    expect(html).toContain('h-3.5 w-1/2');
  });

  test('renders its children', () => {
    expect(renderToStaticMarkup(<Skeleton>inner</Skeleton>)).toContain('>inner</div>');
  });
});

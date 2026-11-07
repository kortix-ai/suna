import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DECKS, countBuilds } from '../registry';

test('every registered deck renders every slide and build stage', () => {
  for (const deck of DECKS) {
    let rendered = 0;
    function RenderDeck() {
      const slides = deck.useSlides();
      expect(slides.length).toBeGreaterThan(0);
      expect(new Set(slides.map((slide) => slide.id)).size).toBe(slides.length);
      expect(countBuilds(slides)).toMatchSnapshot(deck.slug);
      return <>{slides.flatMap((slide) => Array.from({ length: (slide.steps ?? 0) + 1 }, (_, step) => {
        rendered++;
        return <div key={`${slide.id}:${step}`}>{typeof slide.node === 'function' ? slide.node(step) : slide.node}</div>;
      }))}</>;
    }
    const html = renderToStaticMarkup(<RenderDeck />);
    expect(rendered).toBeGreaterThan(0);
    expect(html).toContain('text-foreground');
    expect(html).not.toContain('undefined');
  }
});

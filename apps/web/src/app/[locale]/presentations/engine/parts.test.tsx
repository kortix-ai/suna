import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DECKS, countBuilds } from '../registry';
import { Steps } from './parts';

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

test('Steps retains the four responsive grid hairlines and ordered content', () => {
  const steps = Array.from({ length: 4 }, (_, i) => ({ n: String(i + 1), title: `Stage ${i + 1}`, body: `Action ${i + 1}` }));
  const html = renderToStaticMarkup(<Steps steps={steps} />);
  expect(html).toMatchSnapshot();
  expect((html.match(/<li /g) ?? []).length).toBe(4);
  expect(html).toContain('border-t lg:border-t-0 lg:border-l');
  expect(html).toContain('border-t sm:border-l lg:border-t-0');
});

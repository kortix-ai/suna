import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { GenuiBlock } from '../sdk';
import { GenuiPending, webGenuiComponents } from './index';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const md = (markdown: string) => <pre data-fallback="">{markdown}</pre>;
const render = (code: string) =>
  renderToStaticMarkup(
    <GenuiBlock code={code} streaming={false} components={webGenuiComponents} renderMarkdown={md} renderPending={GenuiPending} />,
  );

describe('web genui components', () => {
  test('layout, data, and inline components render without falling back', () => {
    const html = render(`root = Stack([top, bottom])
top = Stack([stats, card, table, cmp, list])
bottom = Stack([tabs, acc, note, link])
stats = StatRow([s1, s2])
s1 = Stat("Revenue", "12k", "+4%", "up")
s2 = Stat("Users", "900")
card = Card("Option A", "Close to the venue", "4.7 stars", null, null, [tag])
tag = Badge("Top pick", "good")
table = Table(["Name", "Value"], [["a", 1]], "Sample")
cmp = Compare([x, y], ["Price"], "X")
x = CompareItem("X", ["$10"], ["Cheap"])
y = CompareItem("Y", ["$20"], [], ["Pricey"])
list = RankedList([r1])
r1 = RankedItem("First", "Best overall")
tabs = Tabs([t1, t2])
t1 = Tab("One", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")
acc = Accordion([a1])
a1 = AccordionItem("Details", [b1])
note = Callout("warn", "Check the dates", "Note")
link = Link("Book", "https://example.com/book")`);
    for (const text of ['Revenue', '+4%', 'Option A', 'Top pick', 'Sample', 'Cheap', 'Pricey', 'First', 'One', 'Details', 'Check the dates', 'https://example.com/book']) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain('data-fallback');
  });

  test('badges are informational status chips: hue on the tint, label in ink', () => {
    const html = render(`root = Stack([bad, good, plain])
bad = Badge("Sold out", "bad")
good = Badge("Top pick", "good")
plain = Badge("Hotel")`);
    const chip = (label: string) => html.match(new RegExp(`<span[^>]*>${label}</span>`))?.[0] ?? '';
    expect(chip('Sold out')).toContain('data-slot="status-badge"');
    expect(chip('Sold out')).toContain('bg-kortix-red/15');
    expect(chip('Sold out')).toContain('text-foreground');
    expect(chip('Sold out')).not.toContain('text-destructive');
    expect(chip('Top pick')).toContain('bg-kortix-green/15');
    expect(chip('Hotel')).toContain('data-slot="status-badge"');
    expect(chip('Hotel')).not.toContain('kortix-');
  });

  test('an image renders through the markdown image policy with its caption', () => {
    const html = render(`root = Stack([pic])
pic = Image("https://example.com/venue.jpg", "Venue entrance", "The north door")`);
    expect(html).toContain('Venue entrance');
    expect(html).toContain('<figcaption');
    expect(html).toContain('The north door');
    expect(html).not.toContain('data-fallback');
  });

  test('compare keys spec rows by position, so repeated labels do not collide', async () => {
    // Only a client render reports duplicate keys; the server renderer stays silent.
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    let renderer!: ReactTestRenderer;
    try {
      await act(async () => {
        renderer = create(
          <GenuiBlock
            code={`root = Stack([cmp])
cmp = Compare([x, y], ["Price", "Price"])
x = CompareItem("X", ["$10", "$11"])
y = CompareItem("Y", ["$20", "$21"])`}
            streaming={false}
            components={webGenuiComponents}
            renderMarkdown={md}
            renderPending={GenuiPending}
          />,
        );
      });
      const text = JSON.stringify(renderer.toJSON());
      for (const value of ['$10', '$11', '$20', '$21']) expect(text).toContain(value);
      await act(async () => renderer.unmount());
    } finally {
      console.error = original;
    }
    expect(errors.filter((error) => error.includes('same key'))).toEqual([]);
  });

  test('pending heavy nodes reserve height; pending text nodes render nothing', () => {
    const table = renderToStaticMarkup(<>{GenuiPending({ id: 't', type: 'Table', props: {}, partial: true })}</>);
    expect(table).toContain('min-h-[160px]');
    const stat = renderToStaticMarkup(<>{GenuiPending({ id: 's', type: 'Stat', props: {}, partial: true })}</>);
    expect(stat).toBe('');
  });
});

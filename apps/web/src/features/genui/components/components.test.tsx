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

  test('badges: the tone paints the /15 tint only, the label stays ink (AA on every tint); neutral is a muted well', () => {
    const html = render(`root = Stack([bad, good, plain])
bad = Badge("Sold out", "bad")
good = Badge("Top pick", "good")
plain = Badge("Hotel")`);
    const chip = (label: string) => html.match(new RegExp(`<span[^>]*>${label}</span>`))?.[0] ?? '';
    expect(chip('Sold out')).toContain('bg-kortix-red/15');
    expect(chip('Sold out')).toContain('text-foreground');
    expect(chip('Sold out')).not.toMatch(/text-(kortix-red|destructive)/);
    expect(chip('Top pick')).toContain('bg-kortix-green/15');
    expect(chip('Top pick')).toContain('text-foreground');
    expect(chip('Top pick')).not.toContain('text-kortix-green');
    expect(chip('Hotel')).toContain('bg-muted');
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

  test('a table caption is the title above the table, outside its frame, and names the table', () => {
    const html = render(`root = Stack([t])\nt = Table(["Region", "Seats"], [["EU", 1]], "Seats by region")`);
    expect(html).toMatch(/<figure[^>]*><figcaption[^>]*>Seats by region<\/figcaption>[\s\S]*<table[^>]*aria-label="Seats by region"/);
    expect(html).not.toContain('<caption');
    expect(render(`root = Stack([t])\nt = Table(["Region"], [["EU"]])`)).not.toContain('<figure');
  });

  test('the compare pick is named in text and its whole column takes the tint', () => {
    const html = render(`root = Stack([cmp])
cmp = Compare([x, y], ["Price"], "Y")
x = CompareItem("X", ["$10"])
y = CompareItem("Y", ["$20"])`);
    // No visible label: Pick is screen-reader text only.
    expect(html).toMatch(/<th[^>]*>Y<span class="sr-only">Pick<\/span><\/th>/);
    expect(html).toMatch(/<th[^>]*>X<\/th>/);
    expect(html).toMatch(/<th[^>]*class="[^"]*\bbg-hover\b[^"]*"[^>]*>Y</);
    expect(html).toMatch(/<td[^>]*class="[^"]*\bbg-hover\b[^"]*"[^>]*>\$20<\/td>/);
    expect(html).not.toMatch(/<td[^>]*class="[^"]*\bbg-hover\b[^"]*"[^>]*>\$10<\/td>/);
  });

  test('table and compare text cells wrap; numbers stay on one line', () => {
    const html = render(`root = Stack([table, cmp])
table = Table(["Note", "Count"], [["a long note that should wrap inside the message column", 1]])
cmp = Compare([x, y], ["Seat"])
x = CompareItem("X", ["a long value that wraps"])
y = CompareItem("Y", ["short"])`);
    const cell = (text: string) => html.match(new RegExp(`<td[^>]*>${text}</td>`))?.[0] ?? '';
    expect(cell('a long note that should wrap inside the message column')).toContain('whitespace-normal');
    expect(cell('a long value that wraps')).toContain('whitespace-normal');
    expect(cell('1')).not.toContain('whitespace-normal');
  });

  test('a 10-item ranked list keeps rank 10 on one line, right-aligned in a fixed rank lane; #1 leads', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `r${i + 1}`);
    const html = render(
      [`root = Stack([list])`, `list = RankedList([${ids.join(', ')}])`, ...ids.map((id, i) => `${id} = RankedItem("Option ${i + 1}", "Reason")`)].join('\n'),
    );
    const rank = (n: number) => html.match(new RegExp(`<span class="([^"]*)">${n}</span>`))?.[1] ?? '';
    for (const n of [1, 9, 10]) {
      expect(rank(n)).toContain('whitespace-nowrap');
      expect(rank(n)).toContain('text-right');
      expect(rank(n).split(' ')).toContain('w-5');
    }
    // The winner leads: ink rank and a larger title; the runners-up are muted and dense.
    expect(rank(1)).toContain('text-foreground');
    expect(rank(9)).toContain('text-muted-foreground');
    expect(html).toMatch(/<span class="text-foreground min-w-0 font-medium text-balance text-base[^"]*">Option 1<\/span>/);
    expect(html).toMatch(/<span class="text-foreground min-w-0 font-medium text-balance text-sm[^"]*">Option 2<\/span>/);
    // No tiles: a row is not a boxed square any more.
    expect(html).not.toContain('size-10 shrink-0 items-center justify-center');
  });

  test('tab labels truncate with the full label on hover, in a row that scrolls', () => {
    const label = 'Quarterly revenue split';
    const html = render(`root = Stack([tabs])
tabs = Tabs([t1, t2])
t1 = Tab("${label}", [b1])
t2 = Tab("Two", [b2])
b1 = Badge("first")
b2 = Badge("second")`);
    expect(html).toContain(`title="${label}"`);
    expect(html).toMatch(new RegExp(`<span class="[^"]*truncate[^"]*">${label}</span>`));
    expect(html).toContain('overflow-x-auto');
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

  test('two or more images and nothing else render as one masonry gallery; a lone image stays a single figure', () => {
    const img = (id: string) => `${id} = Image("https://example.com/${id}.png", "Photo ${id}", "Caption ${id}")`;
    const ids = (n: number) => ['a', 'b', 'c', 'd', 'e', 'f', 'g'].slice(0, n);
    const three = render(`root = Stack([${ids(3).join(', ')}])\n${ids(3).map(img).join('\n')}`);
    // Two flex columns; before any image loads every tile counts as 4:3, so a, c go left and b right.
    expect(three).toMatch(/<div class="flex items-stretch gap-1\.5"><div class="flex min-w-0 flex-1 flex-col gap-1\.5">/);
    // Balanced: each tile grows by its own ratio (4:3 until it loads) and its image covers it, so no tile
    // is letterboxed and both columns end level.
    expect(three).toMatch(/data-gallery-tile="a" class="[^"]*overflow-hidden[^"]*" style="aspect-ratio:1\.3333333333333333;flex-grow:0\.75"/);
    expect(three).toContain('[&amp;_img]:object-cover');
    // Two images: one row, the same height, each as wide as its shape, so nothing is cropped.
    const pair = render(`root = Stack([a, b])\n${ids(2).map(img).join('\n')}`);
    expect(pair).toMatch(/^<div class="flex gap-1\.5"><div data-gallery-tile="a"[^>]*style="aspect-ratio:1\.3333333333333333;flex-grow:1\.3333333333333333;flex-basis:0"/);
    // The lead always shows its caption; a tile shows its own on hover or focus.
    const caption = (text: string) => three.match(new RegExp(`<figcaption class="([^"]*)"[^>]*>${text}</figcaption>`))?.[1] ?? '';
    expect(caption('Caption a')).not.toContain('opacity-0');
    expect(caption('Caption b')).toContain('opacity-0');
    expect(caption('Caption b')).toContain('group-hover/image:opacity-100');
    const six = render(`root = Stack([${ids(6).join(', ')}])\n${ids(6).map(img).join('\n')}`);
    expect(six).toContain('f.png');
    const seven = render(`root = Stack([${ids(7).join(', ')}])\n${ids(7).map(img).join('\n')}`);
    expect(seven).toContain('+2');
    expect(seven).toContain('e.png');
    expect(seven).not.toContain('f.png');
    const one = render(`root = Stack([a, l])\n${img('a')}\nl = Link("Book", "https://example.com/book")`);
    expect(one).not.toContain('data-gallery-tile');
    expect(one).toContain('Caption a');
  });



  test('two or more cards with layout grid render as masonry: photo, title link, rating with reviews, location, body, tags line', () => {
    const html = render(`root = Stack([list])
list = Stack([a, b], "col", "grid")
a = Card("The Taj Mahal Palace", "Iconic heritage luxury.", "Colaba, South Mumbai", "https://example.com/taj.jpg", "https://example.com/taj", [x, y], 4.7, 33899, "From 24,000 INR")
b = Card("The Oberoi", "Modern rooms.", "Nariman Point")
x = Badge("Luxury")
y = Badge("Heritage")`);
    // Masonry: two columns; the cards keep their order (a, then b in the shorter column).
    expect(html.match(/<ul class="flex min-w-0 flex-1 flex-col gap-6">/g)).toHaveLength(2);
    expect(html.match(/<li data-card="[^"]+" class="flex flex-col gap-3">/g)).toHaveLength(2);
    expect(html).toContain('aspect-ratio:1.3333');
    expect(html).toContain('href="https://example.com/taj"');
    expect(html).toMatch(/4\.7<span class="text-muted-foreground">\(33,899\)<\/span>/);
    expect(html).toContain('From 24,000 INR');
    expect(html).toContain('Colaba, South Mumbai');
    expect(html).toContain('Luxury · Heritage');
    // A card without a photo has no photo column and no rating row.
    expect(html.match(/aspect-ratio:/g)).toHaveLength(1);
  });



  test('a Stat is a cell of the StatRow band and a larger number on its own; the delta color follows the sign', () => {
    const html = render(`root = Stack([row, solo])
row = StatRow([a, b])
a = Stat("Revenue", "1.2M", "+12%", "up")
b = Stat("Churn", "3.1", "-0.8", "down")
solo = Stat("Seats", "418")`);
    expect(html).toContain('bg-border grid');
    expect(html.match(/bg-background px-4 py-3/g)).toHaveLength(2);
    expect(html.match(/font-medium tracking-tight tabular-nums text-lg/g)).toHaveLength(2);
    expect(html).toContain('font-medium tracking-tight tabular-nums text-xl');
    expect(html).toMatch(/text-kortix-green[^>]*><svg[\s\S]*?\+12%/);
    expect(html).toMatch(/text-kortix-red[^>]*><svg[\s\S]*?-0\.8/);
  });
  test('without a hint, cards start as a list: a small whole thumbnail beside the text, hairlines between rows', () => {
    const html = render(`root = Stack([list])
list = Stack([a, b])
a = Card("Python", "General-purpose.", "Language", "https://example.com/python.png")
b = Card("Go", "Backend.", "Language", "https://example.com/go.png")`);
    expect(html).toContain('<ul class="divide-border flex flex-col divide-y">');
    expect(html.match(/<li data-card="[^"]+" class="flex gap-4 py-4/g)).toHaveLength(2);
    expect(html.match(/bg-muted size-18 shrink-0/g)).toHaveLength(2);
    expect(html).not.toContain('aspect-ratio:');
  });
});

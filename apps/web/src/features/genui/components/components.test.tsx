import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GenuiBlock } from '../sdk';
import { GenuiPending, webGenuiComponents } from './index';

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

  test('pending heavy nodes reserve height; pending text nodes render nothing', () => {
    const table = renderToStaticMarkup(<>{GenuiPending({ id: 't', type: 'Table', props: {}, partial: true })}</>);
    expect(table).toContain('min-h-[160px]');
    const stat = renderToStaticMarkup(<>{GenuiPending({ id: 's', type: 'Stat', props: {}, partial: true })}</>);
    expect(stat).toBe('');
  });
});

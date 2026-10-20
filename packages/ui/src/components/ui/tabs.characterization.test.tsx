import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, TabsContent, TabsList, TabsListCompact, TabsTrigger } from './tabs';

test('list recipes preserve markup, caller classes, and inherited orientation', () => {
  const outputs: string[] = [];
  for (const compact of [false, true]) for (const type of ['default', 'underline'] as const)
    for (const animate of ['fluid', 'none'] as const) for (const size of ['xs', 'sm', 'default', 'md', 'lg'] as const)
      for (const orientation of ['horizontal', 'vertical'] as const) {
        const triggers = <><TabsTrigger value="a">Alpha</TabsTrigger><TabsTrigger value="b" variant="outline">Beta</TabsTrigger></>;
        const list = compact
          ? <TabsListCompact type={type} animate={animate} className="caller h-10">{triggers}</TabsListCompact>
          : <TabsList type={type} animate={animate} size={size} orientation={orientation} className="caller h-10">{triggers}</TabsList>;
        const markup = renderToStaticMarkup(<Tabs defaultValue="a" orientation={orientation}>
          <TabsList orientation={orientation}>{list}</TabsList><TabsContent value="a" forceMount>Pane</TabsContent><TabsContent value="b" forceMount>Other</TabsContent>
        </Tabs>);
        const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
        for (const link of markup.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g))
          expect(ids.has(link[1])).toBe(true);
        expect([...markup.matchAll(/aria-controls="([^"]+)"/g)]).toHaveLength(2);
        expect([...markup.matchAll(/aria-labelledby="([^"]+)"/g)]).toHaveLength(2);
        outputs.push(markup.replace(/radix-[^" ]+?(?=-(?:trigger|content)-)/g, 'radix-id'));
      }
  expect(createHash('sha256').update(outputs.join('\n')).digest('hex')).toMatchSnapshot();
});

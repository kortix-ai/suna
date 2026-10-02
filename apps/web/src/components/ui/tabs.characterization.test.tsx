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
        outputs.push(renderToStaticMarkup(<Tabs defaultValue="a" orientation={orientation}>
          <TabsList orientation={orientation}>{list}</TabsList><TabsContent value="a">Pane</TabsContent>
        </Tabs>).replace(/radix-[^"]*/g, 'radix-id'));
      }
  expect(createHash('sha256').update(outputs.join('\n')).digest('hex')).toMatchSnapshot();
});

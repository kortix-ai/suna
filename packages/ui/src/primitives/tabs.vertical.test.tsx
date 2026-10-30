import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const html = (orientation: 'horizontal' | 'vertical') =>
  renderToStaticMarkup(
    <Tabs defaultValue="a" orientation={orientation}>
      <TabsList orientation={orientation}>
        <TabsTrigger value="a">Alpha</TabsTrigger>
        <TabsTrigger value="b">Beta</TabsTrigger>
      </TabsList>
      <TabsContent value="a">Alpha pane</TabsContent>
    </Tabs>,
  );

/** The className string of the element carrying data-slot="tabs-list". */
const listClasses = (out: string): string =>
  out.match(/<div[^>]*data-slot="tabs-list"[^>]*class="([^"]*)"/)?.[1] ?? '';

describe('TabsList orientation', () => {
  test('vertical lists stack and fill their column', () => {
    const out = html('vertical');
    expect(out).toContain('aria-orientation="vertical"');
    expect(listClasses(out)).toContain('flex-col');
    expect(listClasses(out)).toContain('w-full');
  });

  test('vertical lists render no sliding indicator', () => {
    expect(html('vertical')).not.toContain('data-slot="tabs-indicator"');
  });

  test('horizontal lists keep their orientation and do not stack', () => {
    const out = html('horizontal');
    expect(out).toContain('aria-orientation="horizontal"');
    expect(listClasses(out)).not.toContain('flex-col');
  });

  test('the list and the pane are wired together for assistive tech', () => {
    const out = html('vertical');
    expect(out).toContain('aria-controls=');
    expect(out).toContain('aria-labelledby=');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain('aria-selected="true"');
  });

  test('only the active pane is rendered', () => {
    expect(html('vertical').match(/role="tabpanel"/g)).toHaveLength(1);
  });
});

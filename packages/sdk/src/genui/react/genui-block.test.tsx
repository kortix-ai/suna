import { describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { GenuiBlock, type GenuiBlockEvent, type GenuiComponentMap, type GenuiComponentProps } from './genui-block';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const renders = new Map<string, number>();
const count = (id: string) => renders.set(id, (renders.get(id) ?? 0) + 1);

const Stack = ({ node, props, renderChild }: GenuiComponentProps) => {
  count(node.id);
  return <div data-type="Stack">{(props.children ?? []).map(renderChild)}</div>;
};
const Stat = ({ node, props }: GenuiComponentProps) => {
  count(node.id);
  return <span data-type="Stat">{`${props.label}=${props.value}`}</span>;
};
const Boom = (): never => {
  throw new Error('render failure');
};
const COMPONENTS: GenuiComponentMap = { Stack, Stat };
const renderNothing = () => null;
const renderMarkdown = (markdown: string) => <pre data-type="markdown">{markdown}</pre>;

const CODE = 'root = Stack([a, b, c])\na = Stat("A", "1")\nb = Stat("B", "2")\nc = Stat("C", "3")';

function mount(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

describe('GenuiBlock', () => {
  test('a finished statement renders once while later statements stream', () => {
    renders.clear();
    const props = { version: 1, components: COMPONENTS, renderMarkdown };
    const renderer = mount(<GenuiBlock {...props} code={CODE.slice(0, 44)} streaming />);
    // A tick that ends inside a string: lang-core marks every node partial here; Kortix must not.
    const midString = CODE.indexOf('"2"') + 1;
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, midString)} streaming />));
    const cut = CODE.indexOf('\nc =');
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, cut)} streaming />));
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming />));
    // "a" finished in the first tick and its node identity never changed afterwards.
    expect(renders.get('a')).toBe(1);
    expect(renderer.root.findAll((n) => n.props['data-type'] === 'Stat').map((n) => n.children.join(''))).toEqual([
      'A=1',
      'B=2',
      'C=3',
    ]);
  });

  test('disabled renders the markdown fallback', () => {
    const renderer = mount(
      <GenuiBlock code={CODE} streaming={false} enabled={false} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findByProps({ 'data-type': 'markdown' }).children.join('')).toBe('**A:** 1\n\n**B:** 2\n\n**C:** 3');
  });

  test('a component missing from the host map renders that node as markdown', () => {
    const renderer = mount(
      <GenuiBlock code={CODE} streaming={false} components={{ Stack }} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findAllByProps({ 'data-type': 'markdown' }).map((n) => n.children.join(''))).toEqual([
      '**A:** 1',
      '**B:** 2',
      '**C:** 3',
    ]);
  });

  test('a render error falls back to markdown and reports render_error', () => {
    const events: GenuiBlockEvent[] = [];
    const original = console.error;
    console.error = () => {};
    const renderer = mount(
      <GenuiBlock
        code={CODE}
        streaming={false}
        components={{ Stack, Stat: Boom }}
        renderMarkdown={renderMarkdown}
        onSettled={(event) => events.push(event)}
      />,
    );
    console.error = original;
    expect(renderer.root.findByProps({ 'data-type': 'markdown' })).toBeTruthy();
    expect(events.map((e) => e.outcome)).toEqual(['render_error']);
  });

  test('broken source renders nothing raw and reports parse_error', () => {
    const events: GenuiBlockEvent[] = [];
    const renderer = mount(
      <GenuiBlock code="not openui" streaming={false} components={COMPONENTS} renderMarkdown={renderMarkdown} onSettled={(e) => events.push(e)} />,
    );
    expect(renderer.toJSON()).toBeNull();
    expect(events[0]?.outcome).toBe('parse_error');
  });

  test('a block cut off mid-statement renders its valid part and the cut-off note', () => {
    const renderer = mount(
      <GenuiBlock code={'root = Stack([a, b])\na = Stat("A", "1")\nb = Stat("B", "'} streaming={false} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findAll((n) => n.props['data-type'] === 'Stat').map((n) => n.children.join(''))).toEqual(['A=1']);
    expect(renderer.root.findByProps({ 'data-type': 'markdown' }).children.join('')).toBe('*Response was cut off.*');
  });

  test('a newer version shows the unsupported note', () => {
    const renderer = mount(
      <GenuiBlock code={CODE} version={2} streaming={false} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
    );
    expect(renderer.root.findByProps({ 'data-type': 'markdown' }).children.join('')).toContain('newer version');
  });

  test('settled event names components, never content', () => {
    const events: GenuiBlockEvent[] = [];
    const props = { version: 1, components: COMPONENTS, renderMarkdown, onSettled: (e: GenuiBlockEvent) => events.push(e) };
    const renderer = mount(<GenuiBlock {...props} code={CODE} streaming />);
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming={false} />));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'rendered', components: ['Stack', 'Stat'], issueCount: 0 });
    expect(JSON.stringify(events[0])).not.toContain('A=1');
  });

  test('a stable renderMarkdown keeps finished nodes from re-rendering', () => {
    renders.clear();
    const props = { version: 1, components: COMPONENTS, renderMarkdown, renderPending: renderNothing };
    const renderer = mount(<GenuiBlock {...props} code={CODE.slice(0, 44)} streaming />);
    const midString = CODE.indexOf('"2"') + 1;
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, midString)} streaming />));
    const cut = CODE.indexOf('\nc =');
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, cut)} streaming />));
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming />));
    expect(renders.get('a')).toBe(1);
  });

  test('swapping renderMarkdown re-renders the fallback', () => {
    const rendererA = (m: string) => <pre data-r="A">{m}</pre>;
    const rendererB = (m: string) => <pre data-r="B">{m}</pre>;
    const props = { version: 1, enabled: false, components: COMPONENTS, code: CODE, streaming: false };
    const renderer = mount(<GenuiBlock {...props} renderMarkdown={rendererA} />);
    expect(renderer.root.findAllByProps({ 'data-r': 'A' })).toHaveLength(1);
    act(() => renderer.update(<GenuiBlock {...props} renderMarkdown={rendererB} />));
    expect(renderer.root.findAllByProps({ 'data-r': 'B' })).toHaveLength(1);
    expect(renderer.root.findAllByProps({ 'data-r': 'A' })).toHaveLength(0);
  });

  test('swapping renderMarkdown reaches nodes rendered as markdown', () => {
    const rendererA = (m: string) => <pre data-r="A">{m}</pre>;
    const rendererB = (m: string) => <pre data-r="B">{m}</pre>;
    // No Stat entry: every Stat node renders through renderMarkdown.
    const props = { version: 1, components: { Stack } as GenuiComponentMap, code: CODE, streaming: false };
    const renderer = mount(<GenuiBlock {...props} renderMarkdown={rendererA} />);
    expect(renderer.root.findAllByProps({ 'data-r': 'A' }).length).toBeGreaterThan(0);
    act(() => renderer.update(<GenuiBlock {...props} renderMarkdown={rendererB} />));
    expect(renderer.root.findAllByProps({ 'data-r': 'B' }).length).toBeGreaterThan(0);
    expect(renderer.root.findAllByProps({ 'data-r': 'A' })).toHaveLength(0);
  });

  test('the fallback markdown is not computed while a valid block streams', () => {
    let markdownCalls = 0;
    const countingMarkdown = (markdown: string) => {
      markdownCalls += 1;
      return <pre data-type="markdown">{markdown}</pre>;
    };
    const props = { version: 1, components: COMPONENTS, renderMarkdown: countingMarkdown };
    const renderer = mount(<GenuiBlock {...props} code={CODE.slice(0, 44)} streaming />);
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, CODE.indexOf('\nc ='))} streaming />));
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming />));
    expect(markdownCalls).toBe(0);
  });

  test('a throw while streaming gets a fresh try once the stream settles', () => {
    const FlakyStat = ({ node, props, streaming }: GenuiComponentProps) => {
      if (streaming) throw new Error('only while streaming');
      count(node.id);
      return <span data-type="Stat">{`${props.label}=${props.value}`}</span>;
    };
    const components: GenuiComponentMap = { Stack, Stat: FlakyStat };
    const original = console.error;
    console.error = () => {};
    const props = { version: 1, components, renderMarkdown };
    const renderer = mount(<GenuiBlock {...props} code={CODE} streaming />);
    expect(renderer.root.findAllByProps({ 'data-type': 'Stat' })).toHaveLength(0);
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming={false} />));
    console.error = original;
    expect(renderer.root.findAll((n) => n.props['data-type'] === 'Stat').map((n) => n.children.join(''))).toEqual([
      'A=1',
      'B=2',
      'C=3',
    ]);
  });

  test('a disabled block reports no components and no first paint', () => {
    const events: GenuiBlockEvent[] = [];
    // The block parses (its markdown comes from the result), but it renders no UI.
    mount(
      <GenuiBlock
        code={CODE}
        streaming={false}
        enabled={false}
        components={COMPONENTS}
        renderMarkdown={renderMarkdown}
        onSettled={(e) => events.push(e)}
      />,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'fallback', components: [], msToFirstPaint: null });
  });

  test('a disabled block reports no issues', () => {
    const events: GenuiBlockEvent[] = [];
    mount(
      <GenuiBlock
        code={CODE}
        streaming={false}
        enabled={false}
        components={COMPONENTS}
        renderMarkdown={renderMarkdown}
        onSettled={(e) => events.push(e)}
      />,
    );
    // Issues describe rendered UI; a disabled block renders none.
    expect(events[0]?.issueCount).toBe(0);
  });

  test('a disabled block converts to markdown once per distinct code, not once per render', () => {
    let markdownCalls = 0;
    const counting = (markdown: string) => {
      markdownCalls += 1;
      return <pre data-type="markdown">{markdown}</pre>;
    };
    const props = { version: 1, enabled: false, components: COMPONENTS, renderMarkdown: counting };
    const ticks = [CODE.slice(0, 44), CODE.slice(0, CODE.indexOf('\nc =')), CODE];
    const renderer = mount(<GenuiBlock {...props} code={ticks[0]!} streaming />);
    for (const code of ticks.slice(1)) act(() => renderer.update(<GenuiBlock {...props} code={code} streaming />));
    expect(markdownCalls).toBe(3);
    // An identical re-render must not convert (or render the fallback) again.
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming />));
    act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming />));
    expect(markdownCalls).toBe(3);
  });

  test('20,000 nested Stack([ never throws, enabled or disabled', () => {
    const code = `root = ${'Stack(['.repeat(20_000)}Badge("x")${'])'.repeat(20_000)}`;
    for (const enabled of [true, false]) {
      const renderer = mount(
        <GenuiBlock code={code} streaming={false} enabled={enabled} components={COMPONENTS} renderMarkdown={renderMarkdown} />,
      );
      expect(renderer.toJSON()).toBeNull();
    }
  });
});


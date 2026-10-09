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
});

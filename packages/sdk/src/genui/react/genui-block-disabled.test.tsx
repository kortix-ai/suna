import { expect, mock, test } from 'bun:test';
import * as langCore from '@openuidev/lang-core';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Count lang-core parsers: one incremental parser per block, never one per streaming tick.
const real = { ...langCore };
let parsersCreated = 0;
mock.module('@openuidev/lang-core', () => ({
  ...real,
  createStreamingParser: (...args: Parameters<typeof real.createStreamingParser>) => {
    parsersCreated += 1;
    return real.createStreamingParser(...args);
  },
}));

const { GenuiBlock } = await import('./genui-block');
const { GENUI_CUT_OFF_NOTE } = await import('../markdown');

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const CODE = 'root = Stack([a, b])\na = Badge("kept")\nb = Callout("info", "a longer sentence that streams in")';
const renderMarkdown = (markdown: string) => <pre data-type="markdown">{markdown}</pre>;
const shown = (renderer: ReactTestRenderer) =>
  renderer.root.findAllByProps({ 'data-type': 'markdown' }).map((node) => node.children.join(''));

function mount(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
}

test('Rich answers off: streamed ticks never show the cut-off note; a settled cut-off block does', () => {
  const props = { version: 1, enabled: false, components: {}, renderMarkdown };
  const renderer = mount(<GenuiBlock {...props} code={CODE.slice(0, 30)} streaming />);
  const ticks: string[][] = [];
  for (let end = 31; end <= CODE.length; end += 3) {
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, end)} streaming />));
    ticks.push(shown(renderer));
  }
  expect(ticks.flat().some((markdown) => markdown.includes(GENUI_CUT_OFF_NOTE))).toBe(false);
  // Mid-statement ticks show the finished statement only.
  expect(ticks.some((markdown) => markdown.join('') === '[kept]')).toBe(true);

  const cutOff = CODE.slice(0, CODE.indexOf('streams'));
  act(() => renderer.update(<GenuiBlock {...props} code={cutOff} streaming={false} />));
  expect(shown(renderer)).toEqual([`[kept]\n\n*${GENUI_CUT_OFF_NOTE}*`]);
});

test('Rich answers off: a streamed block uses one incremental parser, not one parse per tick', () => {
  const props = { version: 1, enabled: false, components: {}, renderMarkdown };
  const renderer = mount(<GenuiBlock {...props} code={CODE.slice(0, 30)} streaming />);
  parsersCreated = 0;
  for (let end = 31; end <= CODE.length; end += 3) {
    act(() => renderer.update(<GenuiBlock {...props} code={CODE.slice(0, end)} streaming />));
  }
  act(() => renderer.update(<GenuiBlock {...props} code={CODE} streaming={false} />));
  expect(parsersCreated).toBe(0);
});

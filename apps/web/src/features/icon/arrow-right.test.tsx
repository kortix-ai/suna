import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
const start = mock((_state: string) => Promise.resolve());
mock.module('motion/react', () => ({
  useAnimation: () => ({ start }),
  motion: { path: ({ d }: { d: string }) => <path d={d} /> },
}));
mock.module('@kortix/ui', () => ({ cn: (value: string | undefined) => value }));
const { ArrowRightIcon, ARROW_RIGHT_GROUP_CLASS } = await import('./arrow-right');
const window = new Window();
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const container = document.createElement('div'); document.body.append(container);
let root = createRoot(container);
afterEach(async () => {
  await act(() => root.unmount()); root = createRoot(container);
  start.mockClear(); });
function hover(node: import('happy-dom').Element, type: string) { node.dispatchEvent(new window.MouseEvent(type, { bubbles: true })); }
test('standalone hover animates and calls supplied callbacks', async () => {
  const enter = mock(() => {}), leave = mock(() => {});
  await act(() => root.render(<ArrowRightIcon onMouseEnter={enter} onMouseLeave={leave} />));
  const icon = window.document.body.firstElementChild?.firstElementChild;
  if (!icon) throw new Error('missing icon');
  await act(() => { hover(icon, 'mouseover'); hover(icon, 'mouseout'); });
  expect(start.mock.calls).toEqual([['animate'], ['normal']]);
  expect(enter).toHaveBeenCalledTimes(1);
  expect(leave).toHaveBeenCalledTimes(1);
});
test('the nearest group owns animation; icon callbacks still run and unmount removes listeners', async () => {
  const enter = mock(() => {});
  await act(() => root.render(
    <div className={ARROW_RIGHT_GROUP_CLASS}><span><ArrowRightIcon onMouseEnter={enter} /></span></div>,
  ));
  const group = window.document.body.firstElementChild?.firstElementChild, icon = group?.querySelector('span > div');
  if (!group || !icon) throw new Error('missing group or icon');
  await act(() => hover(group, 'mouseenter'));
  await act(() => hover(icon, 'mouseover'));
  await act(() => hover(group, 'mouseleave'));
  expect(start.mock.calls).toEqual([['animate'], ['normal']]);
  expect(enter).toHaveBeenCalledTimes(1);
  await act(() => root.render(null));
  start.mockClear();
  hover(group, 'mouseenter'); hover(group, 'mouseleave');
  expect(start).not.toHaveBeenCalled();
});

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { FileNode } from '@/features/file-browser/types';
import { FilesStoreProvider } from '@/features/file-browser/store/files-store';

const wrapper = ({ children }: { children?: ReactNode }) => <section>{children}</section>;
const item = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>;
mock.module('@/components/ui/context-menu', () => ({ ContextMenu: wrapper, ContextMenuTrigger: wrapper, ContextMenuContent: wrapper, ContextMenuItem: item, ContextMenuSeparator: wrapper }));
mock.module('@/components/ui/dropdown-menu', () => ({ DropdownMenu: wrapper, DropdownMenuTrigger: wrapper, DropdownMenuContent: wrapper, DropdownMenuItem: item, DropdownMenuSeparator: wrapper }));
mock.module('@/features/file-browser/components/file-tree-item', () => ({ DRAG_MIME: 'application/x-file-tree-path' }));
mock.module('./file-thumbnail', () => ({ FileThumbnail: () => null }));
import { DriveGridView } from './drive-grid-view';
import { DriveListView } from './drive-list-view';

const mime = 'application/x-file-tree-path';
const noop = () => {};
let renderer: ReactTestRenderer;
const originalRAF = globalThis.requestAnimationFrame;
const originalTimeout = globalThis.setTimeout;
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.setTimeout = originalTimeout;
});

for (const View of [DriveGridView, DriveListView]) {
  for (const type of ['directory', 'file'] satisfies FileNode['type'][]) {
    describe(`${View.name} ${type}`, () => {
      const node: FileNode = { name: type === 'file' ? 'report.txt' : 'folder', path: 'parent/item', absolute: '/parent/item', type, ignored: false };
      const setup = (readOnly = false) => {
        const rename = mock();
        const move = mock();
        const upload = mock();
        const focus = mock();
        const select = mock();
        const range = mock();
        const frames: FrameRequestCallback[] = [];
        const timers: (() => void)[] = [];
        globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
        globalThis.setTimeout = Object.assign((callback: TimerHandler) => { if (typeof callback === 'function') timers.push(() => callback()); return 1; }, { __promisify__: originalTimeout.__promisify__ });
        act(() => { renderer = create(
          <FilesStoreProvider><View elevatedDirs={[]} dirs={type === 'directory' ? [node] : []} files={type === 'file' ? [node] : []}
            onNavigateToDir={noop} onOpenFile={noop} onPreviewFile={noop} onDownload={noop} onDownloadDir={noop}
            onRename={rename} onDelete={noop} onHistory={noop} onCopy={noop} onCut={noop} onDropMove={move} onDropUpload={upload}
            gitStatusMap={new Map()} isDirDownloading={() => false} readOnly={readOnly} /></FilesStoreProvider>,
          { createNodeMock: (element) => element.type === 'input' ? { value: node.name, focus, select, setSelectionRange: range } : null },
        ); });
        const row = () => renderer.root.findAll((el) => typeof el.type === 'string' && el.props.draggable !== undefined)[0];
        const input = () => renderer.root.findByType('input');
        const start = () => {
          const menu = renderer.root.findAllByType('button').find((el) => el.children.includes('Rename'));
          expect(menu).toBeDefined();
          act(() => menu?.props.onClick());
          expect(renderer.root.findAllByType('input')).toHaveLength(0);
          expect(timers).toHaveLength(1);
          act(() => timers.shift()?.());
        };
        return { rename, move, upload, focus, select, range, frames, row, input, start };
      };
      test('delayed rename, double RAF, selection and drag/click suppression', () => {
        const s = setup(); s.start();
        expect(s.row().props.draggable).toBe(false);
        expect(s.row().props.onClick).toBeUndefined();
        expect(s.focus).not.toHaveBeenCalled();
        act(() => s.frames.shift()?.(0));
        expect(s.focus).not.toHaveBeenCalled();
        act(() => s.frames.shift()?.(0));
        expect(s.focus).toHaveBeenCalledTimes(1);
        if (type === 'directory' && View === DriveGridView) expect(s.select).toHaveBeenCalledTimes(1);
        else expect(s.range).toHaveBeenCalledWith(0, type === 'file' ? 6 : node.name.length);
      });
      for (const finish of ['Enter', 'blur']) {
        for (const name of ['  changed  ', '   ', node.name]) {
          test(`${finish} trims ${JSON.stringify(name)} and rejects no-op`, () => {
            const s = setup(); s.start();
            act(() => s.input().props.onChange({ target: { value: name } }));
            act(() => finish === 'blur' ? s.input().props.onBlur() : s.input().props.onKeyDown({ key: finish, nativeEvent: { isComposing: false } }));
            expect(s.rename.mock.calls).toEqual(name.trim() && name.trim() !== node.name ? [[node, name.trim()]] : []);
            expect(renderer.root.findAllByType('input')).toHaveLength(0);
          });
        }
      }
      test('Enter and the blur that follows rename once; Escape then blur renames nothing', () => {
        const s = setup(); s.start();
        act(() => s.input().props.onChange({ target: { value: 'changed' } }));
        const { onKeyDown, onBlur } = s.input().props;
        act(() => onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false } }));
        act(() => onBlur());
        expect(s.rename.mock.calls).toEqual([[node, 'changed']]);

        s.start();
        act(() => s.input().props.onChange({ target: { value: 'other' } }));
        const cancel = s.input().props;
        act(() => cancel.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false } }));
        act(() => cancel.onBlur());
        expect(s.rename).toHaveBeenCalledTimes(1);
      });
      test('IME Enter does not commit; Escape has the existing layout-specific IME guard', () => {
        const s = setup(); s.start();
        act(() => s.input().props.onChange({ target: { value: 'changed' } }));
        act(() => s.input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } }));
        expect(renderer.root.findAllByType('input')).toHaveLength(1);
        act(() => s.input().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: true } }));
        expect(renderer.root.findAllByType('input')).toHaveLength(View === DriveGridView ? 1 : 0);
        if (View === DriveGridView) act(() => s.input().props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: false } }));
        expect(s.rename).not.toHaveBeenCalled();
      });
      test('drag start sets both payloads and end clears opacity', () => {
        const s = setup(); const setData = mock(); const dataTransfer = { setData, effectAllowed: '' };
        act(() => s.row().props.onDragStart({ dataTransfer }));
        expect(setData.mock.calls).toEqual([[mime, node.path], ['text/plain', node.name]]);
        expect(dataTransfer.effectAllowed).toBe('move');
        expect(s.row().props.className).toContain('opacity-30');
        act(() => s.row().props.onDragEnd());
        expect(s.row().props.className).not.toContain('opacity-30');
      });
      test('nested counters, move guards, empty upload and file no-drop', () => {
        const s = setup();
        const event = (types: string[], source = '') => ({ preventDefault: mock(), stopPropagation: mock(), dataTransfer: { types, files: [], dropEffect: '', getData: () => source } });
        if (type === 'file') {
          if (View === DriveGridView) expect(s.row().props.onDrop).toBeUndefined();
          else { const e = event(['Files']); act(() => s.row().props.onDrop(e)); expect(e.preventDefault).not.toHaveBeenCalled(); }
          return;
        }
        const e = event([mime], 'other');
        act(() => { s.row().props.onDragEnter(e); s.row().props.onDragEnter(e); });
        const highlight = View === DriveGridView ? 'ring-2' : 'bg-primary/8';
        expect(s.row().props.className).toContain(highlight);
        act(() => s.row().props.onDragLeave()); expect(s.row().props.className).toContain(highlight);
        act(() => s.row().props.onDragLeave()); expect(s.row().props.className).not.toContain(highlight);
        act(() => s.row().props.onDragOver(e)); expect(e.dataTransfer.dropEffect).toBe('move');
        for (const source of ['', node.path, 'parent']) act(() => s.row().props.onDrop(event([mime], source)));
        expect(s.move).not.toHaveBeenCalled();
        act(() => s.row().props.onDrop(e)); expect(s.move).toHaveBeenCalledWith('other', node.path);
        const external = event(['Files']);
        act(() => s.row().props.onDragOver(external)); expect(external.dataTransfer.dropEffect).toBe('copy');
        act(() => s.row().props.onDrop(external)); expect(s.upload).toHaveBeenCalledWith([], node.path);
        expect(external.stopPropagation).toHaveBeenCalledTimes(1);
        const unknown = event(['text/plain']); act(() => s.row().props.onDrop(unknown)); expect(unknown.preventDefault).not.toHaveBeenCalled();
      });
      test('readonly hides rename and ignores incoming drops while retaining drag', () => {
        const s = setup(true);
        expect(renderer.root.findAllByType('button').filter((el) => el.children.includes('Rename'))).toHaveLength(0);
        expect(s.row().props.draggable).toBe(true);
        if (s.row().props.onDrop) {
          const e = { preventDefault: mock(), dataTransfer: { types: [mime, 'Files'] } };
          act(() => s.row().props.onDrop(e)); expect(e.preventDefault).not.toHaveBeenCalled();
        }
        expect(s.move).not.toHaveBeenCalled(); expect(s.upload).not.toHaveBeenCalled();
      });
    });
  }
}

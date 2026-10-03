import type { XlsxCellAddress, XlsxSheetData, XlsxViewerController } from '@extend-ai/react-xlsx';
import type { GridSelection } from '@glideapps/glide-data-grid';
import { afterEach, expect, mock, test } from 'bun:test';
import React from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
  type ReactTestRendererJSON,
} from 'react-test-renderer';

const host = (name: string) =>
  function Collaborator({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement(name, props, children);
  };
for (const [path, names] of Object.entries({
  '@/components/ui/button': ['Button'],
  '@/components/ui/input': ['Input'],
  '@/components/ui/popover': ['Popover', 'PopoverContent', 'PopoverTrigger'],
  '@/components/ui/tooltip': ['Tooltip', 'TooltipContent', 'TooltipTrigger', 'TooltipProvider'],
  '@/components/ui/select': [
    'Select',
    'SelectContent',
    'SelectItem',
    'SelectTrigger',
    'SelectValue',
  ],
  '@/components/ui/separator': ['Separator'],
  '@/components/ui/tabs': ['Tabs', 'TabsList', 'TabsTrigger'],
  '@/components/ui/dropdown-menu': [
    'DropdownMenu',
    'DropdownMenuContent',
    'DropdownMenuItem',
    'DropdownMenuRadioGroup',
    'DropdownMenuRadioItem',
    'DropdownMenuTrigger',
  ],
  '@/features/file-renderers/shared/select-compat': [
    'Select',
    'SelectContent',
    'SelectItem',
    'SelectTrigger',
    'SelectValue',
  ],
  '@/features/file-renderers/shared/scroll-area-compat': ['ScrollArea'],
  '@/features/file-renderers/shared/viewer-copy-menu': ['ViewerCopyMenu'],
}))
  mock.module(path, () => Object.fromEntries(names.map((name) => [name, host(name)])));
mock.module('@/i18n/use-translations', () => ({
  useTranslations: () => Object.assign((s: string) => s, { raw: (s: string) => s }),
}));
type SearchSheet = Pick<
  XlsxSheetData,
  | 'name'
  | 'workbookSheetIndex'
  | 'minUsedRow'
  | 'maxUsedRow'
  | 'minUsedCol'
  | 'maxUsedCol'
  | 'visibleRows'
  | 'visibleCols'
>;
type SearchController = Pick<
  XlsxViewerController,
  'activeSheetIndex' | 'clearSelection' | 'selectCell' | 'setActiveSheetIndex' | 'getRowsBatchAsync'
> & { sheets: SearchSheet[] };
let controller: SearchController;
mock.module('@extend-ai/react-xlsx', () => ({
  setWasmSource() {},
  useXlsxViewer: () => controller,
  useXlsxViewerZoom: () => ({ zoomScale: 100, setZoomScale() {} }),
  useXlsxViewerThumbnails: () => ({ thumbnails: [] }),
  useXlsxViewerController: () => controller,
  XlsxViewer: host('grid'),
  XlsxViewerProvider: host('provider'),
}));
mock.module('@glideapps/glide-data-grid', () => ({
  DataEditor: host('grid'),
  CompactSelection: { empty: () => ({}) },
  emptyGridSelection: { columns: {}, rows: {} },
  GridCellKind: { Text: 'text' },
}));
const { CsvViewer } = await import('../csv/csv-viewer');
const { XlsxWorkbookSurface } = await import('../xlsx/xlsx-viewer');
let view: ReactTestRenderer;
let timers = new Map<number, { callback: () => void; ms: number }>();
let id = 0;
const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
function environment() {
  timers = new Map();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost' },
      setTimeout(callback: () => void, ms: number) {
        timers.set(++id, { callback, ms });
        return id;
      },
      clearTimeout(key: number) {
        timers.delete(key);
      },
      requestAnimationFrame() {
        return ++id;
      },
      cancelAnimationFrame() {},
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      documentElement: { classList: { contains: () => false } },
      addEventListener() {},
      removeEventListener() {},
    },
  });
}
afterEach(async () => {
  if (view) await act(() => view.unmount());
  for (const [key, descriptor] of [
    ['window', oldWindow],
    ['document', oldDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function tick(ms = 300) {
  await act(async () => {
    for (const [key, timer] of [...timers])
      if (timer.ms === ms) {
        timers.delete(key);
        timer.callback();
      }
  });
}
const input = () => view.root.findByType('Input');
async function draft(value: string) {
  await act(() => input().props.onChange({ target: { value } }));
}
async function enter(shiftKey = false) {
  await act(() => input().props.onKeyDown({ key: 'Enter', shiftKey, preventDefault() {} }));
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture value');
  return value;
}
async function clear() {
  const button = required(
    view.root.findAllByType('Button').find((n) => n.children.includes('text83b12c2216ef')),
  );
  await act(() => button.props.onClick());
}
function text() {
  const walk = (n: ReactTestRendererJSON | string): string =>
    typeof n === 'string' ? n : (n.children ?? []).map(walk).join('');
  const json = view.toJSON();
  return json === null ? '' : Array.isArray(json) ? json.map(walk).join('') : walk(json);
}
type CsvSearchProps = {
  headers: string[];
  rows: string[][];
  gridRef: React.RefObject<null>;
  dataIdentity: string;
  controlsDisabled: boolean;
  onGridSelectionChange: (selection: GridSelection) => void;
};
function csvPopover(node: ReactTestInstance) {
  const Component = node.type;
  if (typeof Component !== 'function') throw new Error('Expected CSV search component');
  const { headers, rows, gridRef, dataIdentity, controlsDisabled, onGridSelectionChange } =
    node.props;
  if (
    !Array.isArray(headers) ||
    !headers.every((value) => typeof value === 'string') ||
    !Array.isArray(rows) ||
    !rows.every((row) => Array.isArray(row) && row.every((value) => typeof value === 'string')) ||
    typeof gridRef !== 'object' ||
    gridRef === null ||
    gridRef.current !== null ||
    typeof dataIdentity !== 'string' ||
    typeof controlsDisabled !== 'boolean' ||
    typeof onGridSelectionChange !== 'function'
  ) {
    throw new Error('Invalid CSV search props');
  }
  const props: CsvSearchProps = {
    headers,
    rows,
    gridRef,
    dataIdentity,
    controlsDisabled,
    onGridSelectionChange,
  };
  return { props, render: (next: CsvSearchProps) => React.createElement(Component, next) };
}

test('CSV real scan debounces, wraps selection, clears and resets on selection callback identity', async () => {
  environment();
  await act(async () => {
    view = create(<CsvViewer data={'name,value\nAlpha,alpha\nBeta,none'} search />);
  });
  const popover = view.root.find(
    (n) => typeof n.type === 'function' && n.type.name === 'CsvSearchPopover',
  );
  const selections: GridSelection[] = [];
  const search = csvPopover(popover);
  const props = {
    ...search.props,
    onGridSelectionChange: (s: GridSelection) => selections.push(s),
  };
  await act(() => view.update(search.render(props)));
  await draft(' ALPHA ');
  expect(text()).toContain('Searching');
  expect(selections.filter((s) => s.current)).toHaveLength(0);
  await tick();
  expect(required(required(selections.at(-1)).current).cell).toEqual([0, 0]);
  await enter(true);
  expect(required(required(selections.at(-1)).current).cell).toEqual([1, 0]);
  await enter();
  expect(required(required(selections.at(-1)).current).cell).toEqual([0, 0]);
  await draft('   ');
  expect(text()).toContain('No search');
  await draft('alpha');
  await tick();
  await clear();
  expect(input().props.value).toBe('');
  expect(required(selections.at(-1)).current).toBeUndefined();
  await draft('alpha');
  await tick();
  await act(() =>
    view.update(
      search.render({
        ...props,
        onGridSelectionChange: (s: GridSelection) => selections.push(s),
      }),
    ),
  );
  expect(input().props.value).toBe('');
  await draft('alpha');
  await act(() => view.update(search.render({ ...props, dataIdentity: 'changed' })));
  expect(input().props.value).toBe('');
});

test('XLSX scans sheets, uses latest controller without restarting debounce, rejects and fences stale requests', async () => {
  environment();
  const calls: number[] = [];
  const selected: XlsxCellAddress[] = [];
  const switches: number[] = [];
  let clears = 0;
  const pending: { resolve: (rows: unknown[]) => void; reject: (reason: Error) => void }[] = [];
  const sheets: SearchSheet[] = [0, 1].map((i) => ({
    name: `Sheet${i}`,
    workbookSheetIndex: i,
    minUsedRow: 0,
    maxUsedRow: 0,
    minUsedCol: 0,
    maxUsedCol: 0,
    visibleRows: [0],
    visibleCols: [0],
  }));
  controller = {
    sheets,
    activeSheetIndex: 0,
    clearSelection() {
      clears++;
    },
    selectCell(cell: XlsxCellAddress) {
      selected.push(cell);
    },
    setActiveSheetIndex(i: number) {
      switches.push(i);
    },
    getRowsBatchAsync(i: number) {
      calls.push(i);
      return new Promise<unknown[]>((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  const render = (identity: string) => (
    <XlsxWorkbookSurface
      workbookIdentity={identity}
      isDark={false}
      onIsDarkChange={() => {}}
      onUploadClick={() => {}}
      renderTableHeaderMenu={() => null}
      showNightRenderToggle={false}
    />
  );
  await act(() => {
    view = create(render('one'));
  });
  expect(clears).toBe(0);
  await draft('alpha');
  const timerKeys = [...timers.keys()];
  controller = { ...controller };
  await act(() => view.update(render('one')));
  expect([...timers.keys()]).toEqual(timerKeys);
  await tick();
  expect(calls).toEqual([0]);
  await act(async () =>
    required(pending.shift()).resolve([{ index: 0, cells: [{ col: 0, value: 'alpha' }] }]),
  );
  expect(calls).toEqual([0, 1]);
  await act(async () =>
    required(pending.shift()).resolve([{ index: 0, cells: [{ col: 0, value: 'alpha' }] }]),
  );
  expect(selected.at(-1)).toEqual({ row: 0, col: 0 });
  await enter(true);
  expect(switches.at(-1)).toBe(1);
  controller = { ...controller, activeSheetIndex: 1 };
  await act(() => view.update(render('one')));
  expect(text()).toContain('Sheet1!A1');
  await enter();
  expect(switches.at(-1)).toBe(0);
  await clear();
  expect(clears).toBe(1);
  await draft('bad');
  await tick();
  await act(async () => required(pending.shift()).reject(new Error('synthetic')));
  expect(text()).toContain('No results');
  await draft('old');
  await tick();
  const stale = required(pending.shift());
  await draft('new');
  await tick();
  await act(async () => required(pending.shift()).reject(new Error('new fails')));
  await act(async () => stale.resolve([]));
  await act(async () =>
    required(pending.shift()).resolve([{ index: 0, cells: [{ col: 0, value: 'old' }] }]),
  );
  expect(text()).toContain('No results');
  await draft('clear race');
  await tick();
  const cleared = required(pending.shift());
  await clear();
  await act(async () => cleared.reject(new Error('stale')));
  expect(text()).toContain('No search');
  await draft('identity race');
  await tick();
  const changed = required(pending.shift());
  await act(() => view.update(render('two')));
  await act(async () => changed.reject(new Error('stale')));
  expect(input().props.value).toBe('');
  expect(clears).toBe(2);
});

test('CSV changing scan callback restarts debounce; yielded scans reject and cannot overwrite clear or identity', async () => {
  environment();
  await act(async () => {
    view = create(<CsvViewer data={'name\nalpha'} search />);
  });
  const popover = view.root.find(
    (n) => typeof n.type === 'function' && n.type.name === 'CsvSearchPopover',
  );
  const selected: GridSelection[] = [];
  const search = csvPopover(popover);
  let props = {
    ...search.props,
    headers: ['name'],
    rows: Array.from({ length: 501 }, () => ['alpha']),
    onGridSelectionChange: (s: GridSelection) => selected.push(s),
  };
  const render = () => search.render(props);
  await act(() => view.update(render()));
  await draft('alpha');
  const keys = [...timers.keys()];
  props = { ...props, rows: [...props.rows] };
  await act(() => view.update(render()));
  expect([...timers.keys()]).not.toEqual(keys);
  await tick();
  expect(text()).toContain('Searching');
  await draft('none');
  await tick();
  await tick(0);
  expect(text()).toContain('No results');
  await draft('alpha');
  await tick();
  await clear();
  await tick(0);
  expect(input().props.value).toBe('');
  expect(text()).toContain('No search');
  await draft('alpha');
  await tick();
  props = { ...props, dataIdentity: 'another' };
  await act(() => view.update(render()));
  await tick(0);
  expect(input().props.value).toBe('');
  expect(required(selected.at(-1)).current).toBeUndefined();
  const schedule = window.setTimeout;
  window.setTimeout = (callback: TimerHandler, ms?: number) => {
    if (ms === 0) throw new Error('synthetic yield failure');
    return schedule(callback, ms);
  };
  await draft('alpha');
  await tick();
  expect(text()).toContain('No results');
});

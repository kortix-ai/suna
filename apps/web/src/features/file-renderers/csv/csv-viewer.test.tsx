/**
 * KRTX-2230: Download must name the file after the viewer's own `fileName`
 * (with a .csv extension), not a hard-coded 'data.csv'. The test drives the
 * real download path on happy-dom: invoke the toolbar's download handler and
 * read the `download` attribute of the anchor the viewer appends.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { CsvViewer } from './csv-viewer';

const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis;
/** Everything this file installs on globalThis, restored in afterAll. */
const installedKeys = ['window', 'document', 'navigator', 'location', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle'];
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const key of installedKeys) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Reflect.set(globals, key,
    key === 'requestAnimationFrame'
      ? (cb: () => void) => setTimeout(cb, 0)
      : key === 'cancelAnimationFrame'
        ? (id: number) => clearTimeout(id)
        : key === 'getComputedStyle'
          ? win.getComputedStyle.bind(win)
          : Reflect.get(win, key));
}
for (const key of Object.getOwnPropertyNames(win)) {
  // Event classes too: Radix dispatches a `CustomEvent` on a happy-dom node,
  // which accepts only happy-dom's own events, not Bun's.
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    installedKeys.push(key);
    Reflect.set(globals, key, Reflect.get(win, key));
  }
}
if (!win.document.body) {
  win.document.documentElement.append(win.document.createElement('body'));
}

const originalCreateObjectURL = globalThis.URL.createObjectURL;
const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
const originalAnchorClick = win.HTMLAnchorElement.prototype.click;

/** Captures the `download` attribute of every anchor the viewer downloads. */
const downloads: (string | null)[] = [];

globalThis.URL.createObjectURL = () => 'blob:csv-viewer-test';
globalThis.URL.revokeObjectURL = () => {};
win.HTMLAnchorElement.prototype.click = function click() {
  downloads.push(this.download);
};

afterAll(() => {
  if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment);
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  for (const key of installedKeys) {
    const descriptor = originals.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else if (Object.getOwnPropertyDescriptor(globalThis, key)?.configurable) Reflect.deleteProperty(globalThis, key);
  }
  globalThis.URL.createObjectURL = originalCreateObjectURL;
  globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  win.HTMLAnchorElement.prototype.click = originalAnchorClick;
  win.happyDOM.abort();
});

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

async function downloadFromViewer(props: { data: string; fileName?: string }) {
  downloads.length = 0;
  await act(async () => {
    renderer = create(<CsvViewer data={props.data} fileName={props.fileName} />);
  });
  if (!renderer) throw new Error('CsvViewer did not mount');
  const button = renderer.root.findByProps({ 'data-viewer-download': '' });
  await act(async () => {
    button.props.onClick();
  });
  expect(downloads).toHaveLength(1);
  return downloads[downloads.length - 1];
}

describe('CsvViewer download name', () => {
  test('carries the viewer fileName with a .csv extension', async () => {
    const download = await downloadFromViewer({ data: 'a,b\n1,2', fileName: 'quarterly-report' });
    expect(download).toBe('quarterly-report.csv');
  });

  test('keeps an explicit .csv name as is', async () => {
    const download = await downloadFromViewer({
      data: 'a,b\n1,2',
      fileName: 'quarterly-report.csv',
    });
    expect(download).toBe('quarterly-report.csv');
  });

  test('falls back to data.csv when no fileName is given', async () => {
    const download = await downloadFromViewer({ data: 'a,b\n1,2' });
    expect(download).toBe('data.csv');
  });
});

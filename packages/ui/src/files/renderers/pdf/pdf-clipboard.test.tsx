import { afterEach, expect, mock, test } from 'bun:test';
import { act, create } from 'react-test-renderer';
import { PdfClipboard } from './pdf-clipboard';

let onCopy: ((event: { text: string }) => void) | undefined;
const unsubscribe = mock(() => {});
const selection = {
  onCopyToClipboard: (callback: typeof onCopy) => {
    onCopy = callback;
    return unsubscribe;
  },
};
mock.module('@embedpdf/core/react', () => ({ useCapability: () => ({ provides: selection }) }));
const errorToast = mock(() => {});
mock.module('../../../primitives/toast', () => ({ errorToast }));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
  else Reflect.deleteProperty(globalThis, 'navigator');
  errorToast.mockClear();
  unsubscribe.mockClear();
});

for (const denied of [true, false]) {
  test(`PDF selection copy ${denied ? 'reports denied permission without an unhandled rejection' : 'writes text without an error toast'}`, async () => {
    const writeText = mock(() =>
      denied
        ? Promise.reject(new DOMException('Clipboard write is not allowed.', 'NotAllowedError'))
        : Promise.resolve(),
    );
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
    });
    let root: ReturnType<typeof create> | undefined;
    await act(async () => {
      root = create(<PdfClipboard />);
    });
    await act(async () => {
      onCopy?.({ text: 'Synthetic PDF selection' });
    });
    expect(writeText).toHaveBeenCalledWith('Synthetic PDF selection');
    expect(errorToast).toHaveBeenCalledTimes(denied ? 1 : 0);
    if (denied) expect(errorToast).toHaveBeenCalledWith('Could not copy to the clipboard');
    await act(async () => {
      root?.unmount();
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
}

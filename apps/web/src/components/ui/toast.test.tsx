/**
 * Characterization tests for the toast factories in `./toast.tsx`.
 *
 * `toast.tsx` is about to collapse its six factories onto one shared render
 * helper (KRTX-661). These tests pin the CURRENT behavior so the collapse
 * cannot change it: the six factories must keep rendering the same DOM shape
 * with only the icon varying, keep their per-factory duration semantics
 * (`||` fallback vs `??` vs hardcoded `Infinity`), and `errorToast` must keep
 * silently no-oping on request-deadline timeout messages.
 *
 * Sonner is mocked at the module boundary so every factory can be driven
 * without a DOM: `toast.custom`'s render callback is captured and rendered
 * with `renderToStaticMarkup`, which is how the DOM shape is asserted.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type CustomCall = {
  jsx: (id: number | string) => ReactElement;
  data: Record<string, unknown> | undefined;
  id: number;
};

let customCalls: CustomCall[] = [];
const dismissed: Array<string | number> = [];
let nextToastId = 1;

mock.module('sonner', () => ({
  toast: {
    custom: (jsx: (id: number | string) => ReactElement, data?: Record<string, unknown>) => {
      const id = nextToastId++;
      customCalls.push({ jsx, data, id });
      return id;
    },
    dismiss: (id: string | number) => {
      dismissed.push(id);
    },
  },
}));

/** The factories read `window.innerWidth` at call time, so each test sets it. */
const setWindowWidth = (width: number) => {
  (globalThis as { window?: { innerWidth: number } }).window = { innerWidth: width };
};

const { dismissToast, errorToast, infoToast, loadingToast, progressToast, successToast, warningToast } =
  await import('./toast');

beforeEach(() => {
  customCalls = [];
  dismissed.length = 0;
  setWindowWidth(1280);
});

/** Run one factory call and capture the single `toast.custom` call it made. */
const capture = (show: () => unknown) => {
  const before = customCalls.length;
  show();
  expect(customCalls.length).toBe(before + 1);
  const call = customCalls[customCalls.length - 1];
  return { data: call.data, markup: renderToStaticMarkup(call.jsx(call.id)) };
};

/** The icons are the only part of the markup allowed to differ between factories. */
const shapeOf = (markup: string) => markup.replace(/<svg[\s\S]*?<\/svg>/g, '');

type FactoryCase = {
  name: string;
  invoke: () => unknown;
  iconSignature: string;
};

const FACTORIES: FactoryCase[] = [
  { name: 'successToast', invoke: () => successToast('Test message'), iconSignature: 'text-kortix-green' },
  { name: 'progressToast', invoke: () => progressToast('Test message'), iconSignature: 'animate-spin' },
  {
    name: 'loadingToast',
    invoke: () => loadingToast('Test message', new Promise(() => {})),
    iconSignature: 'animate-spin',
  },
  { name: 'errorToast', invoke: () => errorToast('Test message'), iconSignature: 'text-kortix-red' },
  { name: 'infoToast', invoke: () => infoToast('Test message'), iconSignature: 'text-kortix-blue' },
  {
    name: 'warningToast',
    invoke: () => warningToast('Test message'),
    iconSignature: 'text-kortix-yellow',
  },
];

describe('the six factories render one shared toast shape', () => {
  test('every factory renders the same markup, only the icon differs', () => {
    const shapes = new Set<string>();
    for (const { invoke } of FACTORIES) {
      const { markup } = capture(invoke);
      shapes.add(shapeOf(markup));
      // Every variant carries the same container, icon row, message and close button.
      expect(markup).toContain('border-primary/10 bg-background text-foreground');
      expect(markup).toContain('aria-label="Close notification"');
      expect(markup).toContain('Test message');
    }
    expect(shapes.size).toBe(1);
  });

  for (const { name, invoke, iconSignature } of FACTORIES) {
    test(`${name} keeps its distinct icon`, () => {
      const { markup } = capture(invoke);
      expect(markup).toContain(iconSignature);
    });
  }
});

describe('duration semantics differ per factory and must not drift', () => {
  test('success, error, info and warning fall back to 3000 through ||', () => {
    for (const show of [
      () => successToast('m', { duration: 0 }),
      () => errorToast('m', { duration: 0 }),
      () => infoToast('m', { duration: 0 }),
      () => warningToast('m', { duration: 0 }),
    ]) {
      expect(capture(show).data?.duration).toBe(3000);
    }
  });

  test('progressToast keeps a 0 duration through ?? and defaults to Infinity', () => {
    expect(capture(() => progressToast('m', { duration: 0 })).data?.duration).toBe(0);
    expect(capture(() => progressToast('m')).data?.duration).toBe(Infinity);
  });

  test('loadingToast hardcodes Infinity, even when a duration is given', () => {
    expect(
      capture(() => loadingToast('m', new Promise(() => {}), { duration: 5000 })).data?.duration,
    ).toBe(Infinity);
  });

  test('an explicit non-zero duration passes through everywhere', () => {
    for (const show of [
      () => successToast('m', { duration: 8000 }),
      () => progressToast('m', { duration: 8000 }),
      () => errorToast('m', { duration: 8000 }),
      () => infoToast('m', { duration: 8000 }),
      () => warningToast('m', { duration: 8000 }),
    ]) {
      expect(capture(show).data?.duration).toBe(8000);
    }
  });
});

describe('toastData carries the id and the position', () => {
  test('an explicit id reaches toast.custom; a missing or undefined id is omitted', () => {
    expect(capture(() => successToast('m', { id: 'my-toast' })).data).toEqual({
      duration: 3000,
      id: 'my-toast',
      position: 'bottom-right',
    });
    // `id: undefined` must not clobber sonner's generated id (see toastData).
    const noId = capture(() => progressToast('m')).data;
    expect(Object.prototype.hasOwnProperty.call(noId, 'id')).toBe(false);
    const undefinedId = capture(() => errorToast('m', { id: undefined })).data;
    expect(Object.prototype.hasOwnProperty.call(undefinedId, 'id')).toBe(false);
  });

  test('desktop toasts keep their position; mobile toasts pin top-center', () => {
    expect(capture(() => successToast('m')).data?.position).toBe('bottom-right');
    expect(capture(() => successToast('m', { position: 'top-left' })).data?.position).toBe(
      'top-left',
    );
    setWindowWidth(700);
    expect(capture(() => successToast('m')).data?.position).toBe('top-center');
    expect(capture(() => successToast('m', { position: 'top-left' })).data?.position).toBe(
      'top-center',
    );
  });
});

describe('errorToast and the timeout policy', () => {
  test('a request-deadline timeout message renders nothing at all', () => {
    const before = customCalls.length;
    errorToast('Request timed out after 30s: /v1/health');
    expect(customCalls.length).toBe(before);
  });

  test('any other error message renders the red toast', () => {
    const { markup, data } = capture(() => errorToast('Disk almost full'));
    expect(markup).toContain('Disk almost full');
    expect(data?.duration).toBe(3000);
  });
});

describe('ids and dismissal', () => {
  test('progressToast returns the id sonner minted', () => {
    const returned = progressToast('Working');
    expect(returned).toBe(customCalls[customCalls.length - 1].id);
  });

  test('dismissToast dismisses by the id the toast was created with', () => {
    dismissToast('my-toast');
    expect(dismissed).toEqual(['my-toast']);
  });
});

describe('loadingToast promise flow', () => {
  test('resolve dismisses the loading toast and shows the success toast', async () => {
    const before = customCalls.length;
    const returned = loadingToast('Deploying', Promise.resolve('payload'), {
      success: 'Deployed',
    });
    expect(customCalls.length).toBe(before + 1);
    const loadingCall = customCalls[before];
    expect(loadingCall.data?.duration).toBe(Infinity);

    await expect(returned).resolves.toBe('payload');
    expect(dismissed).toContain(loadingCall.id);
    const successCall = customCalls[customCalls.length - 1];
    expect(renderToStaticMarkup(successCall.jsx(successCall.id))).toContain('Deployed');
    expect(renderToStaticMarkup(successCall.jsx(successCall.id))).toContain('text-kortix-green');
  });

  test('the success message falls back to "Completed", or a function of the data', async () => {
    await expect(loadingToast('a', Promise.resolve('d'), {})).resolves.toBe('d');
    expect(renderToStaticMarkup(customCalls[customCalls.length - 1].jsx(
      customCalls[customCalls.length - 1].id,
    ))).toContain('Completed');

    await expect(
      loadingToast('b', Promise.resolve('d2'), { success: (data) => `done: ${data}` }),
    ).resolves.toBe('d2');
    expect(
      renderToStaticMarkup(customCalls[customCalls.length - 1].jsx(
        customCalls[customCalls.length - 1].id,
      )),
    ).toContain('done: d2');
  });

  test('rejection rethrows; the error toast only appears with showErrorToast', async () => {
    const before = customCalls.length;
    const returned = loadingToast('a', Promise.reject(new Error('boom')), {
      showErrorToast: true,
      error: 'Broke',
    });
    expect(customCalls.length).toBe(before + 1);
    const loadingCall = customCalls[before];

    await expect(returned).rejects.toThrow('boom');
    expect(dismissed).toContain(loadingCall.id);
    const errorCall = customCalls[customCalls.length - 1];
    expect(renderToStaticMarkup(errorCall.jsx(errorCall.id))).toContain('Broke');
    expect(renderToStaticMarkup(errorCall.jsx(errorCall.id))).toContain('text-kortix-red');
  });

  test('a rejection without showErrorToast dismisses quietly and still rethrows', async () => {
    const before = customCalls.length;
    const dismissedBefore = dismissed.length;
    await expect(
      loadingToast('b', Promise.reject(new Error('boom2')), {}),
    ).rejects.toThrow('boom2');
    // Only the loading toast rendered (the promise handler dismissed it and
    // showed no error toast because showErrorToast is off).
    expect(customCalls.length).toBe(before + 1);
    expect(dismissed.length).toBe(dismissedBefore + 1);
  });

  test('the error message falls back to the error itself', async () => {
    await expect(
      loadingToast('c', Promise.reject(new Error('raw failure')), { showErrorToast: true }),
    ).rejects.toThrow('raw failure');
    expect(
      renderToStaticMarkup(customCalls[customCalls.length - 1].jsx(
        customCalls[customCalls.length - 1].id,
      )),
    ).toContain('raw failure');
  });
});

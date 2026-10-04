import { describe, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Characterization tests for the toast factories.
 *
 * They pin the behaviour the six factories share today: the one DOM shape, the
 * per-factory icon, the position and duration rules (`||` vs `??`), the `id`
 * passthrough, `errorToast`'s silent early return, and `loadingToast`'s promise
 * chaining. They pass against the pre-refactor file and must keep passing after
 * it, so the refactor cannot change what a toast renders.
 */

type CustomCall = {
  render: (t: string | number) => unknown;
  data: Record<string, unknown>;
};

const customCalls: CustomCall[] = [];
const dismissed: unknown[] = [];

const noop = () => undefined;

mock.module('sonner', () => ({
  toast: {
    success: noop,
    error: noop,
    warning: noop,
    info: noop,
    loading: noop,
    promise: noop,
    message: noop,
    custom: (render: CustomCall['render'], data: Record<string, unknown>) => {
      customCalls.push({ render, data });
      return customCalls.length;
    },
    dismiss: (id: unknown) => {
      dismissed.push(id);
    },
  },
}));

const { successToast, progressToast, loadingToast, errorToast, infoToast, warningToast } =
  await import('./toast');

const setViewport = (width: number) => {
  (globalThis as unknown as { window: unknown }).window = { innerWidth: width };
};

const reset = () => {
  customCalls.length = 0;
  dismissed.length = 0;
  setViewport(1024);
};

const lastData = () => customCalls[customCalls.length - 1].data;

const lastMarkup = () =>
  renderToStaticMarkup(
    customCalls[customCalls.length - 1].render('toast-id') as ReactElement,
  );

/**
 * Replace the leading icon with a fixed placeholder. The first `<svg>` in the
 * markup is always the factory's icon — it precedes the message heading and the
 * close button's glyph. Two factories therefore have the same shape when their
 * markup differs only in that icon.
 */
const shapeOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/, '<ICON/>');

describe('toast factories — shared DOM shape', () => {
  test('all six factories render the same shape; only the icon element varies', () => {
    const options = { description: 'A description', button: <button>Retry</button> };

    reset();
    successToast('Saved', options);
    const success = shapeOf(lastMarkup());

    reset();
    progressToast('Saved', options);
    const progress = shapeOf(lastMarkup());

    reset();
    void loadingToast('Saved', Promise.resolve('ok'), options);
    const loading = shapeOf(lastMarkup());

    reset();
    errorToast('Saved', options);
    const error = shapeOf(lastMarkup());

    reset();
    infoToast('Saved', options);
    const info = shapeOf(lastMarkup());

    reset();
    warningToast('Saved', options);
    const warning = shapeOf(lastMarkup());

    expect(progress).toBe(success);
    expect(loading).toBe(success);
    expect(error).toBe(success);
    expect(info).toBe(success);
    expect(warning).toBe(success);

    expect(success).toContain('>Saved<');
    expect(success).toContain('>A description<');
    expect(success).toContain('aria-label="Close notification"');
    expect(success).toContain('<button>Retry</button>');
  });

  test('each factory carries its own icon class, size and element', () => {
    const icons: Array<[() => void, string]> = [
      [() => successToast('Saved'), 'text-kortix-green size-5 shrink-0'],
      [() => progressToast('Saved'), 'text-primary size-4 shrink-0 animate-spin'],
      [() => errorToast('Saved'), 'text-kortix-red size-6 shrink-0'],
      [() => infoToast('Saved'), 'text-kortix-blue size-6 shrink-0'],
      [() => warningToast('Saved'), 'text-kortix-yellow size-6 shrink-0'],
    ];

    for (const [fire, iconClass] of icons) {
      reset();
      fire();
      expect(lastMarkup()).toContain(iconClass);
    }
  });
});

describe('toast factories — duration', () => {
  test('success, error, info and warning default to DEFAULT_DURATION', () => {
    for (const fire of [
      () => successToast('Saved'),
      () => errorToast('Saved'),
      () => infoToast('Saved'),
      () => warningToast('Saved'),
    ]) {
      reset();
      fire();
      expect(lastData().duration).toBe(3000);
    }
  });

  test('progress and loading render for Infinity', () => {
    reset();
    progressToast('Saved');
    expect(lastData().duration).toBe(Infinity);

    reset();
    void loadingToast('Saved', Promise.resolve('ok'));
    expect(lastData().duration).toBe(Infinity);
  });

  test('an explicit duration is honored', () => {
    for (const fire of [
      () => successToast('Saved', { duration: 500 }),
      () => progressToast('Saved', { duration: 500 }),
      () => errorToast('Saved', { duration: 500 }),
      () => infoToast('Saved', { duration: 500 }),
      () => warningToast('Saved', { duration: 500 }),
    ]) {
      reset();
      fire();
      expect(lastData().duration).toBe(500);
    }
  });

  test('loadingToast renders for Infinity regardless of an explicit duration', () => {
    reset();
    void loadingToast('Saved', Promise.resolve('ok'), { duration: 500 });
    expect(lastData().duration).toBe(Infinity);
  });

  test('duration 0 falls back to the default for `||` factories, and stays 0 for progress', () => {
    // The `||` factories treat 0 as absent; progressToast and loadingToast use
    // `??`/Infinity. Pinned so the refactor cannot quietly unify them.
    reset();
    successToast('Saved', { duration: 0 });
    expect(lastData().duration).toBe(3000);

    reset();
    progressToast('Saved', { duration: 0 });
    expect(lastData().duration).toBe(0);
  });
});

describe('toast factories — position and id', () => {
  test('desktop defaults to bottom-right and honors an explicit position', () => {
    reset();
    successToast('Saved');
    expect(lastData().position).toBe('bottom-right');

    reset();
    successToast('Saved', { position: 'top-left' });
    expect(lastData().position).toBe('top-left');
  });

  test('mobile forces top-center over any explicit position', () => {
    reset();
    setViewport(500);
    successToast('Saved', { position: 'top-left' });
    expect(lastData().position).toBe('top-center');

    reset();
    setViewport(500);
    progressToast('Saved');
    expect(lastData().position).toBe('top-center');
  });

  test('id passes through only when defined', () => {
    reset();
    successToast('Saved', { id: 'my-toast' });
    expect(lastData().id).toBe('my-toast');

    reset();
    successToast('Saved');
    expect('id' in lastData()).toBe(false);
  });
});

describe('errorToast — silent timeout no-op', () => {
  test('a timeout message renders no toast', () => {
    reset();
    errorToast('Request exceeded the 25s server processing deadline');
    expect(customCalls).toHaveLength(0);
  });

  test('any other failure still renders', () => {
    reset();
    errorToast('Failed to save project');
    expect(customCalls).toHaveLength(1);
  });
});

describe('loadingToast — promise chaining', () => {
  test('a resolved promise dismisses the loading toast and shows success', async () => {
    reset();
    const result = await loadingToast('Working', Promise.resolve('done'));

    expect(result).toBe('done');
    expect(dismissed).toEqual([1]);
    expect(customCalls).toHaveLength(2);
    expect(lastMarkup()).toContain('text-kortix-green size-5 shrink-0');
    expect(lastMarkup()).toContain('>Completed<');
  });

  test('a custom success message is used', async () => {
    reset();
    await loadingToast('Working', Promise.resolve(7), { success: (data) => `Got ${data}` });
    expect(lastMarkup()).toContain('>Got 7<');
  });

  test('a rejection with showErrorToast dismisses and shows the error', async () => {
    reset();
    await expect(
      loadingToast('Working', Promise.reject(new Error('boom')), { showErrorToast: true }),
    ).rejects.toThrow('boom');

    expect(dismissed).toEqual([1]);
    expect(customCalls).toHaveLength(2);
    expect(lastMarkup()).toContain('text-kortix-red size-6 shrink-0');
    expect(lastMarkup()).toContain('>boom<');
  });

  test('a rejection without showErrorToast dismisses and renders nothing else', async () => {
    reset();
    await expect(loadingToast('Working', Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );

    expect(dismissed).toEqual([1]);
    expect(customCalls).toHaveLength(1);
  });
});

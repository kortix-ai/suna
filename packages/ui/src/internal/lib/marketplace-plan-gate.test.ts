import { beforeEach, expect, mock, test } from 'bun:test';
import { createTranslator, defaultUiMessages } from '../../i18n';
import { BillingError } from '@kortix/sdk/react';

const errorToast = mock((message: string, options?: { duration?: number }) => undefined);
mock.module('../../primitives/toast', () => ({ errorToast, warningToast: mock() }));
const { handleApiError } = await import('./error-handler');
const t = createTranslator({ locale: 'en', messages: defaultUiMessages, namespace: 'hardcodedUi.i18nComplete' });

beforeEach(() => errorToast.mockClear());

for (const message of [
  'Marketplace installs need a model. Upgrade your plan or connect a provider key, then install again.',
  'This plan does not include managed models. Add your own provider key, then install again.',
]) {
  test(`surfaces the marketplace model gate: ${message}`, () => {
    const error = new BillingError(402, { message, code: 'no_servable_model' });
    handleApiError(error, undefined, t);
    expect(errorToast).toHaveBeenCalledTimes(1);
    expect(errorToast.mock.calls[0]).toEqual([message, { duration: 6000 }]);
  });
}

test('does not toast a silent model-gate background request', () => {
  handleApiError(new BillingError(402, { message: 'Connect a provider key', code: 'no_servable_model' }), { silent: true }, t);
  expect(errorToast).not.toHaveBeenCalled();
});

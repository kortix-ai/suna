/**
 * Test helpers for translated components. `IntlTestProvider` wires use-intl
 * into `<UiProvider i18n>` the way apps/web wires next-intl, so a test can
 * pass its own messages and catch missing keys with `onError`.
 */
import type { ReactNode } from 'react';
import { IntlProvider, useLocale, useTranslations, type IntlConfig } from 'use-intl';

import { createTranslator, defaultUiMessages, type UiI18nHost } from '../i18n';
import { UiProvider } from '../providers/ui-provider';

const HOST: UiI18nHost = { useTranslations, useLocale };

/** A translator for `hardcodedUi.i18nComplete` over the bundled English catalog. */
export const testUiTranslator = createTranslator({
  locale: 'en',
  messages: defaultUiMessages,
  namespace: 'hardcodedUi.i18nComplete',
});

export function IntlTestProvider({
  children,
  locale = 'en',
  timeZone = 'UTC',
  messages = defaultUiMessages as IntlConfig['messages'],
  ...rest
}: Partial<IntlConfig> & { children: ReactNode }) {
  return (
    <IntlProvider locale={locale} messages={messages} timeZone={timeZone} {...rest}>
      <UiProvider i18n={HOST}>{children}</UiProvider>
    </IntlProvider>
  );
}

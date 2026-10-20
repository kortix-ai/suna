/**
 * Test helpers for translated components. `IntlTestProvider` wires use-intl
 * into `<UiProvider i18n>` the way apps/web wires next-intl. A test's own
 * `messages` win; a key they leave out reads the bundled English catalog, as
 * the apps/web test harness did. Pass `fallback={false}` to see missing keys.
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

type Messages = NonNullable<IntlConfig['messages']>;

function merge(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const prev = out[key];
    out[key] =
      typeof value === 'object' && typeof prev === 'object'
        ? merge(prev as Messages, value as Messages)
        : value;
  }
  return out;
}

export function IntlTestProvider({
  children,
  locale = 'en',
  timeZone = 'UTC',
  messages,
  fallback = true,
  ...rest
}: Partial<IntlConfig> & { children: ReactNode; fallback?: boolean }) {
  const base = defaultUiMessages as Messages;
  const resolved = !messages ? base : fallback ? merge(base, messages) : messages;
  return (
    <IntlProvider locale={locale} messages={resolved} timeZone={timeZone} {...rest}>
      <UiProvider i18n={HOST}>{children}</UiProvider>
    </IntlProvider>
  );
}

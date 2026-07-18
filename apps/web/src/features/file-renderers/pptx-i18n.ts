'use client';

import { createInstance, type i18n as I18nType } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { translationsEn } from 'pptx-react-viewer/i18n';

/**
 * pptx-react-viewer renders every label through react-i18next's
 * `useTranslation()` but ships no i18n bootstrap of its own — the host must
 * provide an initialized instance, otherwise the UI shows raw keys like
 * `pptx.toolbar.undo`.
 *
 * We build a dedicated instance (never the global i18next singleton, which the
 * rest of the app doesn't use — it's on next-intl) scoped to the viewer via
 * `<I18nextProvider>`. `translationsEn` is a FLAT map whose keys contain dots,
 * so `keySeparator`/`nsSeparator` must be disabled or i18next would treat the
 * dots as a nested lookup path and miss every string.
 */
let instance: I18nType | null = null;

export function getPptxI18n(): I18nType {
  if (instance) return instance;
  const i18n = createInstance();
  i18n.use(initReactI18next).init({
    resources: { en: { translation: translationsEn } },
    lng: 'en',
    fallbackLng: 'en',
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  instance = i18n;
  return i18n;
}

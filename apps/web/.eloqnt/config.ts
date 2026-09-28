import { defineConfig } from '@eloqnt/cli';

export default defineConfig({
  srcPath: './src',
  messages: {
    path: './translations',
    locales: 'infer',
    sourceLocale: 'en',
    format: 'json',
  },
  lint: {
    rules: {
      // Call sites go through the `@/i18n/*` wrappers around next-intl and
      // `hardcodedUi` keys are looked up at runtime, so usage can't be
      // resolved statically.
      'orphan-message': 'off',
    },
  },
});

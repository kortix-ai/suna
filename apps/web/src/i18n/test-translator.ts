import { createTranslator } from 'next-intl';

import messages from '../../translations/en.json';

export const testUiTranslator = createTranslator({
  locale: 'en',
  messages,
  namespace: 'hardcodedUi.i18nComplete',
});

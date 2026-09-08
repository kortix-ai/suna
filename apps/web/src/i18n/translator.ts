import type { createTranslator } from 'next-intl';

import type messages from '../../translations/en.json';

export type UiTranslator = ReturnType<
  typeof createTranslator<typeof messages, 'hardcodedUi.i18nComplete'>
>;

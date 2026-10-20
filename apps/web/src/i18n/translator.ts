import type { createTranslator } from '@kortix/ui/i18n';

import type messages from '../../translations/en.json';

export type UiTranslator = ReturnType<
  typeof createTranslator<typeof messages, 'hardcodedUi.i18nComplete'>
>;

import { contextToolTrigger as sdkContextToolTrigger } from '@kortix/sdk';

import type { UiTranslator } from '@/i18n/translator';
import type { ToolPart } from '@/ui';

/**
 * Moved to `@kortix/sdk` (`packages/sdk/src/core/turns/tools/tool-meta.ts`)
 * so web and mobile render the transcript from one implementation. This file
 * keeps the old import path working for existing web call sites.
 */
export {
  CONTEXT_TOOLS,
  contextToolSummary,
  getToolPrimaryArg,
  isContextTool,
  normalizeName,
} from '@kortix/sdk';

/**
 * The SDK's `contextToolTrigger` with this app's translated labels.
 */
export function contextToolTrigger(
  part: ToolPart,
  tI18nComplete: UiTranslator,
): {
  title: string;
  subtitle: string;
} {
  return sdkContextToolTrigger(part, {
    read: tI18nComplete.raw('text9b9a8d05a7ec'),
    search: tI18nComplete.raw('text49c266baaaa7'),
    list: tI18nComplete.raw('text6f202f54a7b2'),
    shell: tI18nComplete.raw('texta733285486d5'),
    edit: tI18nComplete.raw('text464c4ffd019e'),
    write: tI18nComplete.raw('text3f00927a7193'),
    fetch: tI18nComplete.raw('textcd7d61bf7e38'),
    webSearch: tI18nComplete.raw('textd04fc7d7e197'),
    scrape: tI18nComplete.raw('text9af605fcac97'),
    applyPatch: tI18nComplete.raw('text01bcfe7a9296'),
    task: tI18nComplete.raw('text4bc74b21357c'),
    worker: tI18nComplete.raw('texta67b04cd5c49'),
    workspace: tI18nComplete.raw('text87bb59ba2f92'),
  });
}

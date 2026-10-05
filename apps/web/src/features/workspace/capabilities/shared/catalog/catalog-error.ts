import type { UiTranslator } from '@/i18n/translator';
/**
 * What a failed catalog load should actually say.
 *
 * Every one of these surfaces used to print "Couldn't load — Check your
 * connection and try again." for any failure at all. For a `500` that sentence
 * is not vague, it is **wrong**: it names a cause (the user's network) that has
 * been ruled out by the fact that a response came back at all, and it sends the
 * one person who could report the fault off to check their wifi instead.
 *
 * The API deliberately returns an opaque body on a 500 (`apps/api/src/index.ts`
 * → `{"error":true,"message":"Internal server error"}`) so schema and table
 * names never reach a client, and that is right — the real cause is in the
 * server log, with `pgCode`, `schema` and `table` attached. So this does not
 * try to explain the failure. It only has to stop misattributing it, and say
 * whether retrying is worth the user's time.
 */

/** The status a failed request came back with, if it came back at all. Reads
 *  `ApiError.status` (`packages/sdk/.../http/api/errors.ts`) without importing
 *  the class — a `instanceof` check across the SDK's ESM build and its IIFE
 *  global can be `false` for the very same error (the dual-package hazard the
 *  SDK's own guide calls out), and this copy is not worth that risk. */
function statusOf(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

export interface CatalogErrorCopy {
  title: string;
  description: string;
  /** Whether to offer Retry. Hidden where pressing it cannot change the
   *  outcome, so the button never becomes the thing that lies instead. */
  canRetry: boolean;
}

export function catalogErrorCopy(error: unknown, tI18nComplete: UiTranslator): CatalogErrorCopy {
  const status = statusOf(error);

  // No status: the request never completed. This is the ONLY case where the
  // user's connection is a fair thing to point at.
  if (status === null) {
    return {
      title: tI18nComplete.raw('text2c1cff23cb89'),
      description: tI18nComplete.raw('text481859b689b0'),
      canRetry: true,
    };
  }

  if (status === 401) {
    return {
      title: tI18nComplete.raw('texte5ee1e7e84aa'),
      description: tI18nComplete.raw('text40f531d6cd85'),
      canRetry: false,
    };
  }

  if (status === 403) {
    return {
      title: tI18nComplete.raw('text9b1f0823459d'),
      description: tI18nComplete.raw('text516f7c6c91fd'),
      canRetry: false,
    };
  }

  if (status === 404) {
    return {
      title: tI18nComplete.raw('texte3ebaa16dd9d'),
      description: tI18nComplete.raw('textf7571d57f984'),
      canRetry: false,
    };
  }

  if (status >= 500) {
    return {
      title: tI18nComplete.raw('textdfe0c2e802b1'),
      description: tI18nComplete('text9ebbc86cb85b', { value0: status }),
      canRetry: true,
    };
  }

  return {
    title: tI18nComplete.raw('text2c1cff23cb89'),
    description: tI18nComplete('text164e80bf993e', { value0: status }),
    canRetry: false,
  };
}

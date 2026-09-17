/**
 * What a prompt that was never sent SAYS, in one sentence.
 *
 * The queue used to render `Not sent — ${last_error}`, and `last_error` is the
 * server's prose: 'admission check failed: no driver for provider',
 * 'prompt accepted by the runtime but never became a message'. It cannot be
 * localized, and half of it names machinery the user has never heard of.
 *
 * The server now records WHY it gave up as a stable code (`failure_code`,
 * `PROMPT_FAILURE_CODES`). A send that fails before the server has a row
 * carries one of the two client codes below. This module is the one place that
 * turns either into words, so the Queue List and the transcript bubble cannot
 * describe the same failure differently.
 *
 * A code this build does not know — an older row, or a newer server — falls
 * back to the reason the server gave, which is still better than silence.
 */

/**
 * The keys below are `hardcodedUi`-scoped, exactly like `queue-action-copy.ts`'s
 * — one convention for the two queue copy modules, so `copy` is always
 * `useTranslations('hardcodedUi').raw` and a caller cannot silently hand in a
 * translator scoped one namespace deeper. `raw` on a missing key renders the
 * key, so a mismatch would reach the user as `textXXXXXXXXXXXX`.
 */

/** "Not sent". The whole line when the cause has no sentence of its own. */
export const QUEUE_NOT_SENT_KEY = 'i18nComplete.textcd5f943d5863';

/**
 * One sentence per cause. The nine server codes (`unknown` deliberately has
 * none — it means the producer could not say), plus the two a send can fail
 * with before the POST: an upload that never became a part, and a request that
 * never reached a server.
 */
export const QUEUE_FAILURE_SENTENCE_KEYS: Readonly<Record<string, string>> = {
  out_of_credits: 'i18nComplete.text2f091e3a2229',
  model_unavailable: 'i18nComplete.textd09060564ee8',
  connector_required: 'i18nComplete.text817349c098e2',
  runtime_unreachable: 'i18nComplete.textc0c5dc672aa9',
  not_landed: 'i18nComplete.text717e78f871af',
  redelivery_exhausted: 'i18nComplete.textc7769deaa190',
  rewound: 'i18nComplete.textc9f209e1bb6a',
  session_gone: 'i18nComplete.texte75ac8cfda29',
  refused: 'i18nComplete.text75cb5a687634',
  upload_failed: 'i18nComplete.text09c52240fd87',
  network: 'i18nComplete.textddbdbadf4ad9',
};

/** The copy key for this cause, or `null` when there is no sentence for it. */
export function queueFailureCopyKey(failureCode: string | null | undefined): string | null {
  if (!failureCode) return null;
  return QUEUE_FAILURE_SENTENCE_KEYS[failureCode] ?? null;
}

/**
 * Can sending this again help?
 *
 * Only `session_gone` says no: the session the prompt was queued in does not
 * exist, so every retry fails the same way. Out of credits, a missing
 * connector or an unreachable runtime are all states the user can change and
 * then retry, so those rows keep their Retry.
 */
export function isRetryableFailure(failureCode: string | null | undefined): boolean {
  return failureCode !== 'session_gone';
}

export interface QueueFailureLine {
  /** The sentence to render. */
  text: string;
  /** The server's own words, for a `title` — never the visible line when a
   *  sentence exists. */
  title?: string;
}

/** The failure line both queue surfaces render. */
export function queueFailureLine(input: {
  failureCode?: string | null;
  lastError?: string | null;
  /** `useTranslations('hardcodedUi').raw`. */
  copy: (key: string) => string;
}): QueueFailureLine {
  const key = queueFailureCopyKey(input.failureCode);
  // The `title` exists to keep the server's own words reachable BEHIND a
  // sentence that replaced them. In the fallback below those words ARE the
  // line, so a title there is a tooltip repeating the text under the pointer.
  if (key) return { text: input.copy(key), ...(input.lastError ? { title: input.lastError } : {}) };
  return {
    text: `${input.copy(QUEUE_NOT_SENT_KEY)}${input.lastError ? ` — ${input.lastError}` : ''}`,
  };
}

/**
 * Change requests this session produced, as outcomes.
 *
 * Server-vouched, deliberately. The agent opens a change request by running
 * `kortix cr open` inside a BASH tool call, and `ToolRegistry.get()` keys on
 * tool name — so a bash call can never route to a custom renderer, and the only
 * text-side signal is stdout. Scraping that would render nothing for a change
 * request opened by a subagent or by the API, and would render a phantom card
 * for `kortix cr open --help`. `origin_session_id` is provenance the server
 * vouches for. One card for a change request that does not exist costs more
 * trust than ten missed cards.
 */

import { localizeUiCatalog } from '../../i18n/ui-catalog/localize-ui-catalog';
import { REMAINING_UI_TRANSLATION_KEYS } from '../../i18n/ui-catalog/remaining-ui-translation-keys.generated';
import type { UiTranslator } from '../../i18n';
import type { ChangeRequest, ChangeRequestStatus } from '@kortix/sdk';

import type { Outcome, OutcomeTone } from '../../internal/outcomes/outcome-types';

/**
 * The word a reader sees for each status.
 *
 * "Applied" rather than "Merged": `changes/change-vocabulary.ts` keeps git words
 * off the screen, and whoever reads this row wants to know the change is in,
 * not which git operation put it there.
 */
export const CR_STATUS_WORD: Record<
  ChangeRequestStatus,
  { label: string; tone: OutcomeTone; action: string }
> = {
  open: { label: 'Waiting for you', tone: 'warning', action: 'Review' },
  merged: { label: 'Applied', tone: 'success', action: 'View' },
  closed: { label: 'Closed', tone: 'neutral', action: 'View' },
};

const FALLBACK_STATUS = {
  label: 'Waiting for you',
  tone: 'warning' as OutcomeTone,
  action: 'Review',
};

/** Epoch ms, or 0. Never NaN — NaN sorts unpredictably and matches no turn span. */
function epoch(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function changeRequestOutcomes(
  crs: ChangeRequest[],
  sessionId: string | undefined,
  tI18nComplete?: UiTranslator,
): Outcome[] {
  // An unknown session shows NOTHING. Falling through to "every change request
  // in the project" would attribute a teammate's work to this turn.
  if (!sessionId) return [];

  return crs
    .filter((cr) => cr.origin_session_id === sessionId)
    .map((cr) => {
      const word = tI18nComplete
        ? localizeUiCatalog(
            CR_STATUS_WORD[cr.status] ?? FALLBACK_STATUS,
            tI18nComplete,
            REMAINING_UI_TRANSLATION_KEYS,
          )
        : (CR_STATUS_WORD[cr.status] ?? FALLBACK_STATUS);
      // `?.` despite the non-null type: this crosses a network boundary, and
      // a server that sends `null` should degrade to the fallback sentence
      // rather than throw inside a transcript render.
      const summary = cr.description?.trim();
      // An agent revises its work by closing this request and opening the next
      // on the same branch. The card says so and opens the replacement
      // (KRTX-3031). The card itself stays this request's: id and reference.
      const replacement = cr.status === 'closed' ? (cr.superseded_by ?? null) : null;
      const status = replacement
        ? {
            label: tI18nComplete
              ? tI18nComplete('textddcd87c21894', { number: replacement.number })
              : `Superseded by #${replacement.number}`,
            tone: word.tone,
          }
        : { label: word.label, tone: word.tone };
      const action = replacement
        ? {
            label: tI18nComplete
              ? tI18nComplete('texta8ef31fa7d25', { number: replacement.number })
              : `View #${replacement.number}`,
            intent: 'open' as const,
            target: replacement.cr_id,
          }
        : { label: word.action, intent: 'open' as const };
      return {
        id: `cr:${cr.cr_id}`,
        kind: 'change_request' as const,
        // The agent's own words, alone. The row used to read
        // "Change request #8 · add jay.md" above a description of
        // "Create jay.md notes file. · into main" — the same idea four times,
        // in a row meant to be scanned in half a second.
        title: cr.title,
        // Kept for the modal, which has room for it. The card no longer renders
        // a description; see `outcome-card.tsx`.
        description:
          summary || tI18nComplete?.raw('text5c58b6d31ba9') || 'Ready for you to look over.',
        status,
        at: epoch(cr.created_at),
        // The number is a REFERENCE, not a name — it belongs in the quiet line
        // with the status. `into <base_ref>` is gone: a branch name is the one
        // piece of git that had reached the screen, and it told a
        // non-technical reader nothing they could act on.
        meta: [
          tI18nComplete
            ? tI18nComplete('texta4fc39798651', { number: cr.number })
            : `Change request #${cr.number}`,
        ],
        action,
        resourceHref: `?cr=${replacement?.cr_id ?? cr.cr_id}`,
      };
    });
}

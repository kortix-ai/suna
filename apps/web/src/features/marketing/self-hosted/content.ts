import { localizeUiCatalog } from '@kortix/ui/i18n';
import { SECURITY_SELFHOST_TRANSLATION_KEYS } from '@/i18n/security-selfhost-translation-keys.generated';
import type { UiTranslator } from '@/i18n/translator';

/**
 * The translated on-box / off-box copy that `boundary-diagram.tsx` renders.
 * The /self-hosted page itself reads `model.ts`; this block stays only for
 * the boundary diagram and its characterization test
 * (`tree-boundary.test.tsx`).
 */

/* ── 1 · what you keep ─────────────────────────────────────────────────────
   HONESTY GATE. The control plane is genuinely yours. Sandbox compute is NOT,
   by default — the API reaches Platinum over egress, and
   the instance must be publicly reachable so the sandbox can call back. Both
   columns below are drawn from that reality, not from a wish. */
export const yours = {
  eyebrow: 'What you keep',
  title: 'The company stays on your side of the wall.',
  titleMuted: 'Sandbox compute runs on your provider.',
  sub: 'Self-hosting is not a smaller Kortix with the interesting parts removed. It is the whole control plane — accounts, projects, repos, secrets, connectors, policies, audit — running inside your network, on storage you back up yourself.',
  onbox: {
    label: 'on your box',
    items: [
      'The Postgres database, as a directory you can back up',
      'File storage, as a second directory next to it',
      'Every project repo and every secret the platform holds',
      'Accounts, roles, policies, triggers, channels and the audit record',
      'The LLM gateway your sessions route model calls through',
    ],
  },
  offbox: {
    label: 'not on your box',
    /** Stated up front on purpose. A reviewer will find this in ten minutes. */
    items: [
      'Agent sandboxes, which run on the provider you configure',
      'The image registry the stack pulls from, which needs no credentials',
    ],
    note: 'Sandbox compute runs on Platinum. Fully isolated topologies are scoped with us rather than self-served.',
  },
} as const;

export function getLocalizedSelfHostedContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog({ yours }, tI18nComplete, SECURITY_SELFHOST_TRANSLATION_KEYS);
}

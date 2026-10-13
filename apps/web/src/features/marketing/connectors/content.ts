import { CONNECTORS_TRANSLATION_KEYS } from '@/i18n/connectors-translation-keys.generated';
import { localizeUiCatalog } from '@/i18n/localize-ui-catalog';
import type { UiTranslator } from '@/i18n/translator';

/**
 * /connectors page copy.
 *
 * Plain English lives here, not in `apps/web/translations/*.json`, so the copy
 * can iterate before paying the 8-locale parity gate (`pnpm i18n:translations`).
 * Wire i18n keys only once the copy is locked.
 *
 * Voice rules: the `kortix-brand` skill. The canonical product noun is CONNECTOR.
 *
 * ACCURACY GATE — every claim below traces to shipped code. Do not soften or
 * inflate these without re-reading the source:
 *  - The sandbox carries one project-scoped token (`KORTIX_TOKEN`) and
 *    zero third-party secrets. Credentials resolve server-side in the connector
 *    gateway (`apps/api/src/connectors/gateway.ts`), which is the chokepoint every
 *    tool call goes through.
 *  - Connector credentials are stored with `scope='connector'` and are
 *    structurally excluded from sandbox env injection
 *    (`apps/api/src/projects/secrets.ts` filters `scope='runtime'`).
 *  - Policy actions are `always_run | require_approval | block`, surfaced as
 *    Allow / Ask / Block (`apps/api/src/connectors/policy.ts`).
 *  - Approval HOLDS the call so the agent's turn pauses and resumes on approve.
 *  - Audit rows land in `kortix.connector_calls` with hashed inputs and
 *    redacted results. The per-session audit view is an Enterprise entitlement —
 *    never write "full org-wide audit trail", that view does not exist.
 *
 * DO NOT WRITE: "grant this connector to this person or department" (retired),
 * "writes require approval by default" (the shipped default is permissive),
 * or anything about the experimental Discover catalogue (off by default).
 */

/* ── 1 · connect once ─────────────────────────────────────────────────────── */

/* ── 2 · the token flow ───────────────────────────────────────────────────── */

export const broker = {
  eyebrow: 'The credential never travels',
  title: 'The agent gets a token. It never gets the key.',
  sub: 'A sandbox is a real Linux machine the model can run anything on. So we do not put your credentials in it. The sandbox carries exactly one Kortix token, scoped to the project, and every outbound call is assembled on our side of the wall.',

  /** The old shape, stated plainly so the new one has something to beat. */
  before: {
    label: 'The usual way',
    title: 'A drawer of keys in the agent’s environment',
    lines: [
      'STRIPE_API_KEY=sk_live_…',
      'NOTION_TOKEN=secret_…',
      'SLACK_BOT_TOKEN=xoxb-…',
      'GITHUB_PAT=ghp_…',
    ],
    body: 'Every key sits in the environment the model reads from. Revoking one means rotating it everywhere it was copied, and any of them can end up in a log line.',
  },
  after: {
    label: 'How Kortix does it',
    title: 'One scoped token, and nothing else',
    lines: ['KORTIX_TOKEN=kortix_pat_…'],
    body: 'Scoped to one project and narrowed again by what that agent is allowed to touch. Turning a connector off takes effect on the next call. Nothing in the sandbox needs rotating, because nothing in the sandbox was ever a secret of yours.',
  },

  /** The diagram, left to right. */
  flow: [
    {
      id: 'agent',
      step: '01',
      title: 'The agent asks',
      mono: 'connector.call("gmail", "send_email", {…})',
      body: 'The agent calls a tool. It names the connector and the action — it has no URL, no host, no key.',
    },
    {
      id: 'broker',
      step: '02',
      title: 'Kortix brokers',
      mono: 'POST /v1/connectors/call',
      body: 'The gateway checks this agent may use this connector, resolves the policy, decrypts the credential server-side, and attaches it to the outbound request.',
    },
    {
      id: 'api',
      step: '03',
      title: 'The API answers',
      mono: 'Authorization: Bearer ••••••••',
      body: 'The third-party API sees a normal authenticated request. The response comes back to the agent. The credential stays behind.',
    },
  ],

  /** Rendered as the "never crosses this line" strip under the diagram. */
  neverLabel: 'Never crosses into the sandbox',
  never: ['API keys', 'OAuth access tokens', 'Refresh tokens', 'Client secrets'],
  /** Rendered as the reassurance row. Each item is a shipped mechanism. */
  guarantees: [
    {
      id: 'encrypted',
      title: 'Encrypted at rest',
      body: 'Connector credentials are encrypted with a per-project key and stored apart from the values a sandbox is allowed to read.',
    },
    {
      id: 'runtime',
      title: 'Injected at call time',
      body: 'The secret is attached to one outbound request and thrown away. It is never written into the sandbox environment.',
    },
    {
      id: 'invisible',
      // ACCURACY: the body scopes this to CONNECTOR credentials, but the title
      // alone — cropped into a screenshot or read by itself — became the blanket
      // "secrets are hidden from the model" claim, which is false.
      title: 'Connector keys stay server-side',
      body: 'The model is never shown a credential, and the ledger stores a hash of the inputs rather than the inputs themselves.',
    },
  ],
} as const;

/* ── 3 · scope ────────────────────────────────────────────────────────────── */

/* ── 4 · policy ───────────────────────────────────────────────────────────── */

export type PolicyStateId = 'allow' | 'ask' | 'block';

/* ── 5 · audit ────────────────────────────────────────────────────────────── */

/* ── 6 · close ────────────────────────────────────────────────────────────── */

export function getLocalizedConnectorsContent(tI18nComplete: UiTranslator) {
  return localizeUiCatalog(
    { broker },
    tI18nComplete,
    CONNECTORS_TRANSLATION_KEYS,
  );
}

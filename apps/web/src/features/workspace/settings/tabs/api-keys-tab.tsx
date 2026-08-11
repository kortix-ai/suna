'use client';

/**
 * The API keys tab — token lifecycle policy + machine identities (service
 * accounts) for CI and automations. Reuses `components/iam/pat-policy-card.tsx`'s
 * `PatPolicyCard` and `components/iam/service-accounts-card.tsx`'s
 * `ServiceAccountsCard` UNMODIFIED, through slots (`patPolicySlot`/
 * `serviceAccountsSlot` below) — same reason `audit-tab.tsx`/`identity-tab.tsx`
 * thread their own real components through a slot: both cards call
 * `useQuery`/`useMutation` internally, so neither can render under
 * `renderToStaticMarkup`. Both are the account page's Tokens pane
 * (`app/(app)/accounts/[id]/page.tsx:589-592`):
 *
 * ```
 * :589   {activeSection === 'tokens' && canWriteAccount ? (
 * :590     <div className="space-y-10">
 * :591       <PatPolicyCard accountId={account.account_id} canManage={canWriteAccount} />
 * :592       <ServiceAccountsCard accountId={account.account_id} canManage={canWriteAccount} />
 * :593     </div>
 * :594   ) : null}
 * ```
 *
 * **Verified: neither card is mounted anywhere else in `apps/web`.**
 * `grep -rln "PatPolicyCard\|ServiceAccountsCard" src` (excluding `*.test.*`)
 * returns exactly three files: `app/(app)/accounts/[id]/page.tsx` (the mount
 * site above) and the two cards' own definition files. `/accounts/**` is
 * deleted in a later ticket (JAY-505); this tab is what keeps both cards
 * reachable once that happens. Neither card is modified here.
 *
 * **The gate — matches the source exactly, not inferred from the tab name.**
 * `app/(app)/accounts/[id]/page.tsx:362 tokens: canWriteAccount === true` —
 * the whole Tokens pane requires `account.write` (admin AND owner), same
 * shape as `billing`/`usage`/`identity` (see those files' header comments),
 * NOT a separate `token.*` leaf. `ApiKeysTabInner` below returns `null`
 * without it. Unlike `audit`/`identity`, the source page's `tokens` branch
 * has **no entitlement content-gate on top** — no `AccountState` query, no
 * `EnterpriseUpsell`, no loading skeleton of its own (confirmed by reading
 * `page.tsx:589-594` in full: the branch is a single `canWriteAccount`
 * condition around the two cards, nothing else) — so `ApiKeysTabView` needs
 * no `isLoading`/`*Enabled` axis, same single-probe shape as
 * `usage-tab.tsx`'s `UsageTabInner`.
 *
 * `canWriteAccount` is sourced from `usePermission(resolvedAccountId,
 * 'account.write')` — the same leaf `billing-tab.tsx`/`usage-tab.tsx`/
 * `identity-tab.tsx` probe for their own whole-tab gate. Both cards take
 * `canManage={canWriteAccount}` — matching `page.tsx:591-592` exactly (one
 * probe feeds both the tab gate and both cards' manage gate, no second
 * probe needed, since neither card has its own stricter leaf the way
 * `AuditWebhooksCard` does).
 *
 * **Account id.** `useSettingsAccountId(accountId)` — same shape as every
 * other Phase 3 tab; never `project?.account_id` alone.
 *
 * **Column-gap finding (task brief, "scope correction").** The task
 * originally specified a table with columns `name, prefix, scope, created,
 * last used`, merging user CLI tokens and account service accounts. No
 * second table is built here — `ServiceAccountsCard` already renders one
 * (`service-accounts-card.tsx:131-145`, columns `Name / Status / Last used /
 * actions`), and it is mounted unmodified as `serviceAccountsSlot`. Checked
 * against the backing type (`packages/sdk/src/core/rest/projects-client/
 * iam.ts:735-745`, `ServiceAccount`):
 *
 * | Requested column | Backing field                    | Rendered today? |
 * | ----------------- | -------------------------------- | ---------------- |
 * | name               | `name`                           | yes — `service-accounts-card.tsx:147` |
 * | prefix             | `public_prefix`                  | yes, but as a secondary line under the name, not its own column — `service-accounts-card.tsx:148-150` |
 * | scope              | **none** — no `scope` field on `ServiceAccount` at all | no |
 * | created            | `created_at` — exists on the record | **no** — not rendered anywhere in the card |
 * | last used          | `last_used_at`                   | yes — `service-accounts-card.tsx:161-163` |
 *
 * So: `name` and `last used` have both a field and a rendered column.
 * `prefix` has a field but is not a standalone column (it's inline under the
 * name). `created` has a field (`created_at`) that the card never surfaces
 * at all — a real gap, not a missing-data one; adding a "Created" column
 * would need no new backend work, just a card change, which is out of this
 * task's scope (the card is explicitly not to be modified — see above).
 * `scope` has no backing field on the record whatsoever — IAM policies
 * attach to a service account as a *principal* (`service-accounts-card.tsx:
 * 107-108`, "Attach policies just like a member"), which is a separate
 * join, not a field on this row. Fabricating or blanking any of these was
 * ruled out by the task brief; this table documents the gap instead.
 *
 * **The one new element — a copyable auth snippet.** Everything else in this
 * tab already existed; the snippet showing how to send the key as a bearer
 * token did not. Built with the shared `CopyButton`
 * (`components/markdown/copy-button.tsx`) — not a hand-rolled copy control,
 * per the task brief — in the same `bg-muted/30 rounded-md border` + `pre`
 * shell `gateway-api-reference.tsx`'s `CodeBlock` already uses for the same
 * job, so it doesn't invent a fourth "code sample" visual dialect alongside
 * that one, `code-block.tsx`'s `CodeBlock`, and `_shared.tsx`'s. The
 * snippet is static markup (no accountId-scoped data, no hooks beyond
 * `CopyButton`'s own `useState`), so it lives directly in the pure view
 * rather than as a slot.
 *
 * **Pagination — an open question, not a decision.** The task brief raised
 * whether the service-account list should paginate and left it unanswered.
 * This tab implements neither a new table nor pagination of any kind — the
 * existing `ServiceAccountsCard` table has none today, and nothing here adds
 * any. Stated plainly so it doesn't read as a settled "no" by omission.
 *
 * `ApiKeysTabView` is the pure, props-only half — no hooks, no data
 * fetching. The `account.write` whole-tab gate lives in `ApiKeysTabInner`
 * (the container), which can't render under `renderToStaticMarkup` with no
 * providers mounted — `api-keys-tab.test.tsx` documents this the same way
 * `usage-tab.test.tsx` never renders `UsageTab` directly, only
 * `UsageTabView`.
 *
 * **Untestable here, by design (see the task brief's constraints):** every
 * PAT-policy save, every service-account create/disable/delete mutation, and
 * the one-time bearer-reveal dialog all need a live network and a real DOM.
 * `bun test` has no DOM. `api-keys-tab.test.tsx` covers what the pure view
 * can prove statically: both slots render, in order, alongside the snippet.
 */

import type { ReactNode } from 'react';

import { PatPolicyCard } from '@/components/iam/pat-policy-card';
import { ServiceAccountsCard } from '@/components/iam/service-accounts-card';
import { CopyButton } from '@/components/markdown/copy-button';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { usePermission } from '@/lib/use-permission';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

/** Bearer-auth curl example. Static — no account-scoped data — so it needs
 *  no slot and renders directly in the pure view. Mirrors the shape of the
 *  orphaned `features/accounts/settings/cli-tokens-tab.tsx`'s
 *  `ApiKeyUsageExamples` (confirmed unused elsewhere: `grep -rln
 *  "cli-tokens-tab\|CliTokensTab\b" src` returns only that file itself) without
 *  reusing its env-dependent `apiBase` resolution or its hand-rolled local
 *  `CopyButton` — this tab uses the shared one instead, per the task brief. */
const AUTH_SNIPPET = `curl https://api.kortix.com/v1/projects \\
  -H "Authorization: Bearer <api-key>"`;

function AuthSnippet() {
  return (
    <div className="bg-muted/30 relative overflow-hidden rounded-md border">
      <pre className="scrollbar-hide overflow-x-auto p-3 pr-11 font-mono text-xs leading-relaxed">
        <code className="text-foreground whitespace-pre">{AUTH_SNIPPET}</code>
      </pre>
      <div className="absolute top-1.5 right-1.5">
        <CopyButton code={AUTH_SNIPPET} />
      </div>
    </div>
  );
}

export interface ApiKeysTabViewProps {
  /** `PatPolicyCard`, built by the container once an accountId is known —
   *  see this file's header comment for why it can't render under
   *  `renderToStaticMarkup`. Rendered first, matching `page.tsx:591`. */
  patPolicySlot?: ReactNode;
  /** `ServiceAccountsCard` — see this file's header comment. Rendered
   *  second, matching `page.tsx:592`. */
  serviceAccountsSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `ApiKeysTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `UsageTabView` for the same split. Does NOT encode the `account.write`
 *  whole-tab gate — that lives in `ApiKeysTabInner`, see this file's header
 *  comment. */
export function ApiKeysTabView({ patPolicySlot, serviceAccountsSlot }: ApiKeysTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="space-y-10">
        <SettingsTabHeader tab="api-keys" />
        {patPolicySlot}
        {serviceAccountsSlot}

        <section className="space-y-4">
          <SettingsSectionHeader
            title="Using a key"
            description="Send it as a bearer token on every request."
          />
          <AuthSnippet />
        </section>
      </div>
    </div>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `ApiKeysTabInner` so every hook below only runs while this tab is
 *  actually mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees
 *  that only happens while this tab is the active one. */
export function ApiKeysTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <ApiKeysTabInner accountId={resolvedAccountId} />;
}

function ApiKeysTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  // account.write — the whole-tab gate (see this file's header comment),
  // same leaf billing-tab.tsx/usage-tab.tsx/identity-tab.tsx probe for their
  // own whole-tab gate. Also the value forwarded to both cards' own
  // `canManage` prop, matching page.tsx:591-592 exactly.
  const { allowed: canWriteAccount } = usePermission(resolvedAccountId, 'account.write');

  // Whole-tab gate — account.write. Placed after every hook above so the
  // hook count never changes render to render (same shape as
  // BillingTabInner/UsageTabInner/IdentityTabInner's own whole-tab gates).
  if (!canWriteAccount) return null;

  return (
    <ApiKeysTabView
      patPolicySlot={
        resolvedAccountId ? (
          <PatPolicyCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
      serviceAccountsSlot={
        resolvedAccountId ? (
          <ServiceAccountsCard accountId={resolvedAccountId} canManage={canWriteAccount} />
        ) : undefined
      }
    />
  );
}

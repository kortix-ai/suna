'use client';

/**
 * The API keys tab — every key that lets something act on this workspace
 * without signing in, plus the rules the workspace puts on them.
 *
 * **What changed, and why (Jay, 2026-08-12).** This tab used to be two
 * imported cards stacked in a `max-w-4xl` column: a "CLI token lifecycle"
 * policy form and a "service accounts" table. Four things were wrong with it,
 * and each is fixed here:
 *
 * 1. *No way to create an API key.* The only key you could make from this tab
 *    was a service account. The CLI/API key flow lived in
 *    `features/accounts/settings/cli-tokens-tab.tsx`, which was mounted
 *    nowhere — deleted with this change, since both kinds now create from one
 *    dialog reached from the pane header (`components/iam/api-keys-card.tsx`).
 * 2. *An empty state nobody wanted.* "No service accounts yet" with an icon and
 *    a second create button, on a tab that already has one. With no keys the
 *    list now renders nothing at all.
 * 3. *The table was not aligned with anything.* Its cells were `align-top`, so
 *    the status badge and both dates floated above a two-line name cell, and
 *    the tab added its own `px-6 py-10` on top of the padding the pane already
 *    applies. It is still a table — Jay's call, and the right one for six
 *    columns of key metadata — but the Members pane's borderless dialect, with
 *    middle-aligned cells, in the `max-w-4xl` column the width rule gives a
 *    tab that renders a table.
 *
 *    On top of the table: a search field over the name, the key hint and the
 *    scope, a status filter (All / Active / Expired / Revoked, each with a
 *    live count) and a type filter (All / Personal / Automation). "Expired" is
 *    derived rather than stored — see `ApiKeyStatus` in `api-key-rows.ts`.
 * 4. *It read as machine documentation.* "Personal Access Tokens", "the mint
 *    endpoint refuses PATs without an `expires_at`", "attach policies… as the
 *    principal". The copy is rewritten end to end — see
 *    `components/iam/key-rules-card.tsx` for the before/after table on the
 *    rules half.
 *
 * **Permissions — three leaves, not one.** The old tab gated everything on
 * `account.write`, which is admin-only, so a plain member could not so much as
 * see the keys their own workspace uses. The backend is more precise and this
 * now matches it exactly: `token.read` for the list (every member has it —
 * `iam/role-perms.ts`'s `MEMBER_BASELINE`), `token.create` for the create
 * action, `token.revoke` for the row actions (both in `ADMIN_EXTRAS`, and both
 * grantable to a member by explicit policy), and `account.write` for the rules
 * form (`PATCH /accounts/{id}/iam/pat-policy` asserts exactly that). One
 * batched probe, one roundtrip.
 *
 * **Two panes, one header.** The keys table is one tab; "Using a key" and the
 * key rules share the other, because neither is something you came here to
 * read — they are what you consult once, or set once. The pane title and the
 * Create key button stay above the tab bar so the create path is one click
 * from either. Underline tabs, the same primitive and the same arrangement as
 * the Members pane.
 *
 * **The split.** `ApiKeysTabView` is pure and props-only so it renders under
 * `renderToStaticMarkup` with no providers; `ApiKeysTab` is the container that
 * owns the hooks, including which tab is showing (Radix unmounts an inactive
 * `TabsContent`, so a controlled `section` prop is also the only way a test
 * can see the second pane). Same shape as `MembersTabView`. The keys table and
 * the rules form arrive as slots because both call `useQuery` internally.
 */

import { type ReactNode, useState } from 'react';

import { ApiKeysList, CreateApiKeyDialog } from '@/components/iam/api-keys-card';
import { KeyRulesCard } from '@/components/iam/key-rules-card';
import { CopyButton } from '@/components/markdown/copy-button';
import { Button } from '@/components/ui/button';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getEnv } from '@/lib/env-config';
import { usePermissions } from '@/lib/use-permission';
import { PlusIcon } from '@phosphor-icons/react';

import { SettingsTabHeader } from '../settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

/**
 * Used when the container has not resolved the deployment's own API base —
 * and in tests, which render the pure view directly. Kortix cloud's public
 * base; a self-hosted install sees its own (see `ApiKeysTabInner`).
 */
const DEFAULT_API_BASE = 'https://api.kortix.com/v1';

/** One batched probe for the whole tab. Declared at module scope so the array
 *  identity is stable across renders and `usePermissions` does not refetch. */
const KEY_PROBES = [
  { action: 'token.read' },
  { action: 'token.create' },
  { action: 'token.revoke' },
  { action: 'account.write' },
];

function UsageSnippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="bg-muted/30 overflow-hidden rounded-md border">
      {/* Padding sits on the inner sections, never on the bordered element —
          the label row and the code block share a seam. */}
      <div className="flex items-center justify-between gap-2 border-b py-1 pr-1 pl-3">
        <span className="text-muted-foreground truncate text-xs">{label}</span>
        <CopyButton code={code} size="sm" className="shrink-0" />
      </div>
      <pre className="scrollbar-hide overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code className="text-foreground whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

/** The two underline tabs this pane is split into. */
export type ApiKeysSection = 'keys' | 'usage';

export interface ApiKeysTabViewProps {
  /** Which tab is showing. Controlled by the container so this view stays
   *  hook-free — the same shape `MembersTabView` uses. Defaults to `keys`. */
  section?: ApiKeysSection;
  onSectionChange?: (section: ApiKeysSection) => void;
  /** The pane header's create action — the container supplies it once
   *  `token.create` resolves true. Sits above the tab bar, so it is reachable
   *  from either tab. */
  headerAction?: ReactNode;
  /** `ApiKeysList`. A slot because it calls `useQuery` internally and so
   *  cannot render under `renderToStaticMarkup`. */
  keysSlot?: ReactNode;
  /** `KeyRulesCard`, for admins only. Same reason it is a slot. */
  rulesSlot?: ReactNode;
  /** This deployment's API base, already including `/v1`. */
  apiBase?: string;
}

/** Presentational only — no hooks, no data fetching. See the header comment. */
export function ApiKeysTabView({
  section = 'keys',
  onSectionChange = () => {},
  headerAction,
  keysSlot,
  rulesSlot,
  apiBase = DEFAULT_API_BASE,
}: ApiKeysTabViewProps) {
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      {/* The pane heading and the create action sit ABOVE the tab bar: they
          title the whole pane, and a create button that disappeared when you
          opened the rules would reintroduce the exact complaint this tab was
          rebuilt for. Same arrangement as the Members pane. */}
      <SettingsTabHeader tab="api-keys" action={headerAction} />

      <Tabs
        value={section}
        onValueChange={(next) => onSectionChange(next as ApiKeysSection)}
        className="gap-6"
      >
        <TabsList type="underline" className="flex h-auto w-full items-center justify-start">
          <TabsTrigger value="keys" className="w-fit flex-none pb-3">
            Keys
          </TabsTrigger>
          <TabsTrigger value="usage" className="w-fit flex-none pb-3">
            {/* No rules form for a non-admin, so the label must not promise
                one — they get the snippets only. */}
            {rulesSlot ? 'Usage & rules' : 'Usage'}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="keys" className="space-y-4">
          {keysSlot}
        </TabsContent>

        <TabsContent value="usage" className="space-y-8">
          <section className="space-y-4">
            <SettingsSubsectionHeader
              title="Using a key"
              description="Paste it into the Kortix CLI, or send it along with a request."
            />
            <div className="space-y-2">
              <UsageSnippet label="Sign in to the CLI" code={'kortix login --token <your-key>'} />
              <UsageSnippet
                label="Call the API"
                code={`curl ${apiBase}/projects \\\n  -H "Authorization: Bearer <your-key>"`}
              />
            </div>
          </section>

          {rulesSlot}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Container entry point. Resolves the account id once, then hands off to
 *  `ApiKeysTabInner` so every hook below only runs while this tab is actually
 *  mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees that. */
export function ApiKeysTab({ accountId }: { accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <ApiKeysTabInner accountId={resolvedAccountId} />;
}

function ApiKeysTabInner({ accountId: resolvedAccountId }: { accountId: string | undefined }) {
  const [canRead, canCreate, canRevoke, canWriteAccount] = usePermissions(
    resolvedAccountId,
    KEY_PROBES,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [section, setSection] = useState<ApiKeysSection>('keys');

  // `BACKEND_URL` can be root-relative in the sandbox-preview deploy mode
  // ('/v1'); absolutize it against the current origin so the copied curl is
  // pasteable as-is. Same resolution the orphaned `cli-tokens-tab.tsx` used.
  const rawApiBase = getEnv().BACKEND_URL || DEFAULT_API_BASE;
  const apiBase = (
    rawApiBase.startsWith('/') && typeof window !== 'undefined'
      ? window.location.origin + rawApiBase
      : rawApiBase
  ).replace(/\/+$/, '');

  // Whole-tab gate — `token.read`. After every hook, so the hook count never
  // changes render to render (the shape every other tab's gate uses).
  if (!resolvedAccountId || !canRead?.allowed) return null;

  return (
    <>
      <ApiKeysTabView
        section={section}
        onSectionChange={setSection}
        apiBase={apiBase}
        headerAction={
          canCreate?.allowed ? (
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5 transition-transform active:scale-[0.96]"
              onClick={() => setCreateOpen(true)}
            >
              <PlusIcon className="size-4 shrink-0" />
              Create key
            </Button>
          ) : undefined
        }
        keysSlot={
          <ApiKeysList accountId={resolvedAccountId} canManage={canRevoke?.allowed === true} />
        }
        rulesSlot={
          canWriteAccount?.allowed ? (
            <KeyRulesCard accountId={resolvedAccountId} canManage />
          ) : undefined
        }
      />
      {canCreate?.allowed ? (
        <CreateApiKeyDialog
          accountId={resolvedAccountId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />
      ) : null}
    </>
  );
}

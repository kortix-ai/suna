'use client';

/**
 * `ConnectAppsStrip` — 3-4 broadly useful connectors, ready to connect
 * without leaving the panel, plus a way to the full catalogue.
 *
 * A brand-new project has an empty Context card and nothing to look at. The
 * strip is what fills that gap: a handful of apps most sessions eventually
 * reach for, one click from connected, so the first thing a project owner
 * sees is a start, not a blank promise.
 *
 * **Row idiom matches `ContextCard`'s** (`rounded-sm px-1 py-1.5 gap-2.5`,
 * `size-7` leading box) — this strip is meant to live beside or inside that
 * card, so the two must read as one system. Unlike a `ContextCard` row, the
 * whole row is not a button: a nested "Connect" `<button>` inside a row
 * `<button>` is invalid HTML (`PanelCard`'s header hit the same constraint —
 * see its own comment), so the row is a plain `<div>` and only "Connect"
 * carries a click. The row therefore carries NO `hover:` state either: a
 * pointer tint on a `<div>` that answers no click promises an affordance the
 * row does not have, and the nested Connect button already has its own.
 *
 * **Connect is a two-step sequence: declare, then open the gate.**
 * `ConnectorRequiredNotice`'s `openConnectorGate` call (this strip's model for
 * the store call itself — see below) only ever fires for a connector the
 * project ALREADY has a manifest row for, because the server only refuses a
 * send over a connector it already knows about. This strip's whole reason to
 * exist is the opposite case — a brand-new project with nothing declared —
 * so calling the gate directly would send `usePipedreamConnectProject` (which
 * the dialog drives) into `reconcileConnection`, which 404s
 * (`apps/api/src/projects/routes/r4.ts:688`, "Connector not found") when no
 * `connectors` row exists yet. Declaring the row first is what the
 * connectors page's own Add flow (`EasyConnectAddFlow`) already does before
 * IT ever opens a connection dialog — `createConnector` +
 * `buildEasyConnectConnectorDraft`, both imported from there rather than
 * re-implemented, are the exact functions that write the manifest entry and
 * trigger the server-side sync. This strip reuses those two functions
 * directly instead of the whole `EasyConnectAddFlow` component: that
 * component's job is naming a NEW connection through a modal (name/slug
 * chosen by the user), which would turn one click into two steps for a
 * connector whose name and slug are already fixed. `declareThenOpenGate`
 * below is the smallest reuse that keeps this a single click.
 *
 * **Declaring is idempotent.** `buildEasyConnectConnectorDraft` sets
 * `create_only: true` (via `createOnlyConnectorDraft`), so a slug the
 * manifest already carries — an earlier click here, or the connectors page's
 * own Add flow having already added it — 409s with `ApiError`. That 409 is
 * caught and treated as success: the row is exactly as declared as a fresh
 * `createConnector` call would have left it, so the gate opens the same way
 * either path. Any OTHER failure (network, a genuine validation error) stops
 * short of the gate and surfaces `errorToast` instead — opening a gate for a
 * connector that was never declared would just move the 404 one step later.
 * A partial failure (manifest written, sync failed —
 * `connectorSyncErrorForSlug`) also stops short: the DB row `reconcileConnection`
 * needs isn't there yet either, so the gate would 404 just the same.
 *
 * **The gate then opens for ONE connector at a time.** `openConnectorGate` is
 * the same store `ConnectorRequiredNotice` uses for a failed-send refusal,
 * but that caller hands it every connector a blocked turn needs; this one
 * hands it a single-item list — "connect this app, in place, no
 * navigation" — so the modal it opens shows exactly the row that was
 * clicked, nothing else. `retry` is a no-op: there is no refused send
 * waiting behind this click.
 *
 * **Read via `getState()`, not the `useConnectorGateStore(selector)` hook.**
 * The action is a stable reference created once by `create()`, so nothing
 * here needs to re-render when the gate's OWN state changes — this
 * component doesn't care whether the gate is open. That keeps the component
 * hook-free, which is what lets its tests call it as a plain function and
 * inspect the returned element tree directly, the same harness
 * `context-card.test.tsx` uses (see that file's `cardBody`).
 *
 * **The icon is `FaviconAvatar`,** the same favicon-avatar primitive
 * `ContextCard`'s own web-source rows already render, not the connectors
 * page's `ConnectorAppIcon`/`ConnectorIcon`. Both of those key off an
 * `AdminConnector` (a real project connector row) or a fetched catalogue
 * entry's `icon` URL — data this strip deliberately doesn't fetch, since its
 * whole point is to render before a project has connected anything. A
 * domain plus `FaviconAvatar` gets the same visual language with zero
 * network calls beyond the icon image itself.
 */

import { Button } from '@/components/ui/button';
import { errorToast, warningToast } from '@/components/ui/toast';
import { FaviconAvatar } from '@/components/ui/favicon-avatar';
import {
  buildEasyConnectConnectorDraft,
  connectorSyncErrorForSlug,
} from '@/features/workspace/customize/sections/connector-connection-form';
import { useConnectorGateStore } from '@/stores/connector-gate-store';
import { ApiError, createConnector } from '@kortix/sdk';
import Link from 'next/link';

interface DefaultConnector {
  /** `connector_alias` / catalogue slug — verified against real usage below. */
  slug: string;
  name: string;
  /** One line: what connecting this actually gets you. */
  value: string;
  /** Domain `FaviconAvatar` resolves a real favicon from. */
  domain: string;
}

/**
 * A curated default, not the full ~5,758-app catalogue (that lives at
 * `/projects/{id}/connectors`) — four apps a first-time project is likely to
 * want, picked for breadth (mail, chat, docs, storage) rather than any
 * ranking the catalogue itself exposes.
 *
 * Every slug is verified against a real usage site in this repo, not
 * invented:
 * - `gmail` — `connector_alias: 'gmail'` in
 *   `packages/sdk/src/core/rest/projects-client/connectors.test.ts:49`, and
 *   the marketing copy's `connector.call("gmail", "send_email", …)` example
 *   (`features/marketing/connectors/content.ts`).
 * - `slack` — `setConnectorCredentialMode('P1', 'slack', …)` in the same SDK
 *   test file (line 325), and channel copy referring to Slack by name.
 * - `notion` — named alongside Gmail/Linear/GitHub in the same marketing
 *   copy's connector-catalogue screenshot caption.
 * - `google_drive` — the literal slug asserted in
 *   `features/workspace/customize/sections/connector-connection-form.test.ts:80`
 *   (`{ slug: 'google_drive', name: 'Google Drive' }`).
 *
 * `CATEGORY_PICKS` in `catalog/connector-picks.ts` independently pins all
 * four under `communication`/`productivity`, confirming they are apps the
 * catalogue itself treats as recognisable defaults.
 */
export const DEFAULT_CONNECTORS: readonly DefaultConnector[] = [
  {
    slug: 'gmail',
    name: 'Gmail',
    value: 'Read and send email from your inbox.',
    domain: 'gmail.com',
  },
  {
    slug: 'slack',
    name: 'Slack',
    value: 'Post updates and read channels.',
    domain: 'slack.com',
  },
  {
    slug: 'notion',
    name: 'Notion',
    value: 'Read and write pages and databases.',
    domain: 'notion.so',
  },
  {
    slug: 'google_drive',
    name: 'Google Drive',
    value: 'Read and organize your files.',
    domain: 'drive.google.com',
  },
];

/** Full-width row, matching `ContextCard`'s dense idiom minus the click
 *  semantics AND minus its hover tint — see this file's header for why it's a
 *  `div`, not a `button`, and why a non-interactive row carries no `hover:`. */
const ROW_CLASS = '-mx-0.5 flex min-h-10 w-full items-center gap-2.5 rounded-sm px-1 py-1.5';

/**
 * Declare this connector in the project's manifest (idempotent on a slug it
 * already carries), then open the gate for it — see this file's header for
 * why both steps exist and why a 409 falls through instead of stopping.
 */
async function declareThenOpenGate(projectId: string, connector: DefaultConnector) {
  try {
    const draft = buildEasyConnectConnectorDraft(
      { slug: connector.slug, name: connector.name },
      { name: connector.name, slug: connector.slug, authorizationStrategy: 'project' },
    );
    const result = await createConnector(projectId, draft);
    const syncError = connectorSyncErrorForSlug(result, connector.slug);
    if (syncError) {
      warningToast(
        `Added ${connector.name} to the manifest, but synchronization failed: ${syncError}. Use Sync to retry.`,
      );
      return;
    }
  } catch (err) {
    // 409 = already declared — `create_only` makes this the idempotent case
    // (an earlier click here, or the connectors page's own Add flow already
    // added it), so fall through to the gate exactly as a fresh declare
    // would. Any other failure stops here: opening the gate for a connector
    // that was never declared would just move the 404 one step later.
    if (!(err instanceof ApiError) || err.status !== 409) {
      errorToast(err instanceof Error ? err.message : `Couldn't add ${connector.name}`);
      return;
    }
  }

  useConnectorGateStore.getState().openConnectorGate({
    projectId,
    connectorConnections: [
      {
        id: connector.slug,
        slug: connector.slug,
        name: connector.name,
        authorization_strategy: 'project',
      },
    ],
    retry: () => {},
  });
}

export function ConnectAppsStrip({ projectId }: { projectId: string | undefined }) {
  if (!projectId) return null;

  return (
    <div className="flex flex-col gap-0">
      <ul className="flex flex-col gap-0">
        {DEFAULT_CONNECTORS.map((connector) => (
          <li key={connector.slug} className="flex items-center">
            <div className={ROW_CLASS}>
              <span className="flex size-7 shrink-0 items-center justify-center">
                <FaviconAvatar value={connector.domain} size="sm" alt="" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-foreground truncate text-sm">{connector.name}</span>
                <span className="text-muted-foreground truncate text-xs">{connector.value}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => declareThenOpenGate(projectId, connector)}
              >
                Connect
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Button asChild variant="ghost" size="sm" className="justify-start">
        <Link href={`/projects/${projectId}/connectors`}>View all</Link>
      </Button>
    </div>
  );
}

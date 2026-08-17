'use client';

/**
 * API keys — every credential this project's LLM stack has, on one screen.
 *
 * ## Why one tab and not three
 *
 * The gateway sub-tab bar carried TWO tabs both labelled "API keys" and, next
 * to them, a third called "API":
 *
 *  - `providers` — "API keys": paste YOUR provider key (Anthropic, OpenAI, …)
 *    so this project can call that provider.
 *  - `keys` — "API keys": create a `kortix_gw_…` key so something OUTSIDE
 *    Kortix can call this project's gateway. The opposite direction.
 *  - `api` — "API": how to make that outside call, with the key from the tab
 *    four places to its left.
 *
 * Two identical labels four tabs apart is not a naming problem, it is a
 * structure problem: they are the same question ("what keys does this project
 * have?") answered in three places, and the reference for using a key was
 * never on the same screen as the key. They are now three SECTIONS here, in
 * the order the work actually happens — bring a provider key in, hand a
 * gateway key out, call it — and each one says which direction it points.
 *
 * Each section renders bare (no scroller, no padding of its own); this file
 * owns the one scroll container, the padding and the headings, so the page
 * reads as one column rather than three nested panes.
 */

import { useState, type ReactNode } from 'react';

import { ProviderConnect } from '@/features/providers/provider-connect';
import { GatewayApiReference } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';
import { useGatewayKeys } from '@/hooks/projects/use-project-gateway';

/**
 * One labelled band. A heading, a sentence saying which way the key points,
 * and the section's own UI — the minimum that stops two lists of keys from
 * reading as one list of keys.
 */
function KeySection({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div className="space-y-0.5">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-xs text-pretty">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function LlmApiKeysTab({
  projectId,
  canWrite,
  enabled,
  onViewModels,
}: {
  projectId: string;
  canWrite: boolean;
  /** Set while this surface is visible; drives the provider queries. */
  enabled: boolean;
  /** Jump to the Models tab — the reference and the reveal dialog both offer it. */
  onViewModels: () => void;
}) {
  // The gateway origin the reference prints. Only this tab needs it, and this
  // tab is only mounted while it is open (Radix unmounts inactive panels), so
  // a read-only member never eats the manage-keys 403 on some other tab.
  const gatewayKeysQuery = useGatewayKeys(projectId);
  const gatewayUrl = gatewayKeysQuery.data?.gateway_url ?? null;

  // The reference is long — three endpoints, six samples. It is documentation
  // for the section above it, not a fourth thing to read on the way in, so it
  // opens on request and the page still ends with the keys.
  const [showReference, setShowReference] = useState(false);

  // The host `TabsContent` owns the scroll container (`min-h-0
  // overflow-y-auto`), same as every other panel in `gateway-view.tsx`. A
  // second scroller here would trap the wheel inside a nested pane.
  return (
    <div className="w-full space-y-5 p-5">
      <KeySection
        title="Provider keys"
        description="Your own key with a model provider. Kortix uses it to call that provider on this project's behalf, for everyone on the project."
      >
        {/* `ProviderConnect` draws its own `px-5 py-5`; this column already has
            the padding, so it is overridden rather than nested. */}
        <ProviderConnect
          projectId={projectId}
          canWrite={canWrite}
          enabled={enabled}
          className="gap-4 p-0"
        />
      </KeySection>

      <KeySection
        title="Gateway keys"
        description={
          <>
            The other direction: a <code className="font-mono">kortix_gw_…</code> key lets an app
            outside Kortix call this project&apos;s gateway, using the provider keys above.
          </>
        }
      >
        <GatewayKeys projectId={projectId} canWrite={canWrite} onViewModels={onViewModels} />
      </KeySection>

      <KeySection
        title="Calling the gateway"
        description="Drop-in OpenAI- and Anthropic-compatible endpoints. Use a gateway key from the section above."
      >
        {showReference ? (
          <GatewayApiReference
            apiKey="kortix_gw_..."
            gatewayUrl={gatewayUrl}
            onViewModels={onViewModels}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowReference(true)}
            className="text-muted-foreground hover:text-foreground cursor-pointer text-xs underline underline-offset-2 transition-colors"
          >
            Show the endpoints and code samples
          </button>
        )}
      </KeySection>
    </div>
  );
}

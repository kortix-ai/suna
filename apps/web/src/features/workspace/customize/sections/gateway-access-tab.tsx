'use client';

/**
 * Gateway — a `kortix_gw_…` key, and the endpoints it opens.
 *
 * ## One direction per tab
 *
 * The gateway bar used to carry THREE key surfaces, two of them sharing a
 * label:
 *
 *  - `providers` — "API keys": paste YOUR provider key (Anthropic, OpenAI, …)
 *    so this project can call that provider. **Inbound.**
 *  - `keys` — "API keys": create a `kortix_gw_…` key so something OUTSIDE
 *    Kortix can call this project's gateway. **Outbound.**
 *  - `api` — "API": how to make that outbound call, with the key from the tab
 *    four places to its left.
 *
 * The first fix merged all three into one tab, on the argument that they are
 * one question ("what keys does this project have?") answered in three places.
 * That traded two identical labels for one tab that answered two opposite
 * questions, and buried the reference under a 180-row provider list.
 *
 * The split is now by DIRECTION, which is the thing a reader is actually
 * choosing between: **Providers** is the key you bring in, **Gateway** is the
 * key you hand out plus how to use it. Two destinations, each with one job.
 * `LLM_TABS` in `gateway-view.tsx` holds the order; both legacy deep-link ids
 * (`llm-keys`, `llm-api`) resolve here, because this is where their content
 * lives.
 *
 * Each section renders bare — no scroller, no padding of its own.
 * `CapabilityPageShell` owns the page's one scroll container and its column;
 * this file only supplies the two headings.
 */

import type { ReactNode } from 'react';

import { GatewayApiReference } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';
import { useGatewayKeys } from '@/hooks/projects/use-project-gateway';

/**
 * One labelled band. A heading, a sentence saying what the section is for, and
 * the section's own UI — the minimum that stops "make a key" and "call the
 * thing with it" from reading as one undifferentiated wall.
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

export function GatewayAccessTab({
  projectId,
  canWrite,
  onViewModels,
}: {
  projectId: string;
  canWrite: boolean;
  /** Jump to the Models tab — the reference and the reveal dialog both offer it. */
  onViewModels: () => void;
}) {
  // The gateway origin the reference prints. Only this tab needs it, and the
  // tab only renders while it is the active one, so a read-only member never
  // eats the manage-keys 403 while reading some other tab.
  const gatewayKeysQuery = useGatewayKeys(projectId);
  const gatewayUrl = gatewayKeysQuery.data?.gateway_url ?? null;

  // The reference renders open, not behind a disclosure. It sat collapsed
  // while it was the third section of a tab about provider keys, where it was
  // a fourth thing to read on the way past. This tab IS the reference — half
  // of its stated job — so hiding it behind a click would leave the tab
  // answering only the half a reader can already see.
  return (
    <div className="w-full space-y-5">
      <KeySection
        title="Gateway keys"
        description={
          <>
            A <code className="font-mono">kortix_gw_…</code> key lets an app outside Kortix call
            this project&apos;s gateway, using the provider keys on the Providers tab.
          </>
        }
      >
        <GatewayKeys projectId={projectId} canWrite={canWrite} onViewModels={onViewModels} />
      </KeySection>

      <KeySection
        title="Calling the gateway"
        description="Drop-in OpenAI- and Anthropic-compatible endpoints. Use a gateway key from the section above."
      >
        <GatewayApiReference
          apiKey="kortix_gw_..."
          gatewayUrl={gatewayUrl}
          onViewModels={onViewModels}
        />
      </KeySection>
    </div>
  );
}

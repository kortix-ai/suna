'use client';

import { GatewayApiReference } from '@/features/workspace/customize/sections/view/gateway/gateway-api-reference';
import { GatewayKeys } from '@/features/workspace/customize/sections/view/gateway/gateway-keys';

/**
 * API access — the Developer sub-tab pairing key management with the gateway
 * API reference in one scroll container. Both `llm-keys` and `llm-api`
 * deep-links land here (Task 16 first stacked the two panels inline; Task 18
 * pulled the stack out into its own component and dropped the shared
 * cross-tab-hop callback prop the two panels used to carry — Models is a
 * sibling top-level tab, not something this Developer-surface panel jumps to
 * anymore).
 */
export function GatewayApiAccess({
  projectId,
  canWrite,
  gatewayUrl,
}: {
  projectId: string;
  canWrite: boolean;
  /** Env-correct public gateway origin (dev vs prod); falls back to prod inside `GatewayApiReference`. */
  gatewayUrl: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <GatewayKeys projectId={projectId} canWrite={canWrite} />
      <div className="border-border w-full space-y-4 border-t p-5">
        <div className="space-y-1">
          <p className="text-foreground text-sm font-medium">Use these models from your code</p>
          <p className="text-muted-foreground text-xs text-pretty">
            Drop-in OpenAI- and Anthropic-compatible endpoints for calling this project's gateway
            from outside a Kortix session.
          </p>
        </div>
        <GatewayApiReference apiKey="kortix_gw_..." gatewayUrl={gatewayUrl} />
      </div>
    </div>
  );
}

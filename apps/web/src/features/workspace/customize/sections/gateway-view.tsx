'use client';

/**
 * LLM — the per-project gateway, surfaced as a group of Customize sections
 * (Overview, Providers, Logs, Budgets, Keys) rather than one tab with its own
 * top-tab nav. Each is a normal Customize section so it reads exactly like
 * Agents / Skills / Secrets, controlled from the left rail.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { GatewayBudgets } from '@/components/projects/gateway/gateway-budgets';
import { GatewayKeys } from '@/components/projects/gateway/gateway-keys';
import { GatewayLogs } from '@/components/projects/gateway/gateway-logs';
import { GatewayOverview } from '@/components/projects/gateway/gateway-overview';
import { ProjectProviderModal } from '@/features/workspace/customize/sections/llm-provider/llm-provider-modal';
import { useCustomizeStore } from '@/stores/customize-store';

function LlmSectionShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}

export function LlmGatewayEnablePrompt({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <div className="max-w-md space-y-3">
        <h2 className="text-foreground text-lg font-medium">LLM Gateway is off for this project</h2>
        <p className="text-muted-foreground text-sm text-balance">
          Turn on the experimental LLM Gateway feature in Settings to route this project through
          the managed gateway and unlock Overview, Providers, Logs, Budgets, and Keys.
        </p>
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
      </div>
    </div>
  );
}

export function LlmOverviewView({ projectId }: { projectId: string }) {
  return (
    <LlmSectionShell>
      <GatewayOverview projectId={projectId} />
    </LlmSectionShell>
  );
}

export function LlmProvidersView({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  return (
    <LlmSectionShell>
      <ProjectProviderModal
        asPanel
        projectId={projectId}
        open={open}
        onOpenChange={() => {}}
        defaultTab="connected"
      />
    </LlmSectionShell>
  );
}

export function LlmLogsView({ projectId }: { projectId: string }) {
  return (
    <LlmSectionShell>
      <GatewayLogs projectId={projectId} />
    </LlmSectionShell>
  );
}

export function LlmBudgetsView({ projectId }: { projectId: string }) {
  return (
    <LlmSectionShell>
      <GatewayBudgets projectId={projectId} />
    </LlmSectionShell>
  );
}

export function LlmKeysView({ projectId }: { projectId: string }) {
  return (
    <LlmSectionShell>
      <GatewayKeys projectId={projectId} />
    </LlmSectionShell>
  );
}

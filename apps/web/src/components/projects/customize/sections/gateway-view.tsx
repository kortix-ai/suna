'use client';

/**
 * LLM — the per-project gateway, surfaced as a group of Customize sections
 * (Overview, Providers, Logs, Budgets, Keys) rather than one tab with its own
 * top-tab nav. Each is a normal Customize section so it reads exactly like
 * Agents / Skills / Secrets, controlled from the left rail.
 *
 * "Providers" merges the old Models + Providers tabs into one surface — the
 * provider panel already exposes Connected · Add provider · Models inline, with
 * "Add provider" as a first-class action.
 */

import type { ReactNode } from 'react';
import { Boxes, Gauge, KeyRound, ScrollText, Wallet, type LucideIcon } from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
import { GatewayBudgets } from '@/components/projects/gateway/gateway-budgets';
import { GatewayKeys } from '@/components/projects/gateway/gateway-keys';
import { GatewayLogs } from '@/components/projects/gateway/gateway-logs';
import { GatewayOverview } from '@/components/projects/gateway/gateway-overview';
import { ProjectProviderModal } from '@/components/projects/project-provider-modal';
import { useCustomizeStore } from '@/stores/customize-store';

function Frame({
  icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <CustomizeSectionHeader icon={icon} title={title} />
      {children}
    </div>
  );
}

export function LlmOverviewView({ projectId }: { projectId: string }) {
  return (
    <Frame icon={Gauge} title="Overview">
      <GatewayOverview projectId={projectId} />
    </Frame>
  );
}

export function LlmProvidersView({ projectId }: { projectId: string }) {
  const open = useCustomizeStore((s) => s.open);
  return (
    <Frame icon={Boxes} title="Providers">
      <ProjectProviderModal
        asPanel
        projectId={projectId}
        open={open}
        onOpenChange={() => {}}
        defaultTab="connected"
      />
    </Frame>
  );
}

export function LlmLogsView({ projectId }: { projectId: string }) {
  return (
    <Frame icon={ScrollText} title="Logs">
      <GatewayLogs projectId={projectId} />
    </Frame>
  );
}

export function LlmBudgetsView({ projectId }: { projectId: string }) {
  return (
    <Frame icon={Wallet} title="Budgets">
      <GatewayBudgets projectId={projectId} />
    </Frame>
  );
}

export function LlmKeysView({ projectId }: { projectId: string }) {
  return (
    <Frame icon={KeyRound} title="API keys">
      <GatewayKeys projectId={projectId} />
    </Frame>
  );
}

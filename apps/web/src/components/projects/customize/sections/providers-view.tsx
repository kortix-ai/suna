'use client';

/**
 * Providers — the per-project BYOK provider surface, shown as a Customize
 * section. Lets a user connect their own provider keys (Anthropic / OpenAI /
 * OpenRouter / …); opencode then auto-detects each native provider and lists its
 * models alongside Kortix's managed models. (The old gateway "product" sections —
 * Overview / Logs / Budgets / Keys — were removed with the heavy LLM gateway.)
 */

import type { ReactNode } from 'react';
import { Boxes, type LucideIcon } from 'lucide-react';

import { CustomizeSectionHeader } from '@/components/projects/customize/customize-section-header';
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

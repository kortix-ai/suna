'use client';

/**
 * The two pieces of coding-agent presentation shared between the section panel
 * (`coding-agents-panel.tsx`) and a single agent's detail card
 * (`agent-editor.tsx`): the brand mark, and the picker that repoints an agent
 * at a different coding agent.
 *
 * The picker exists so switching one agent's coding agent costs one dropdown
 * instead of the four clicks it used to (Edit configuration → scroll to ACP
 * runtime → Routing → Runtime profile → Save). The full editor still owns
 * everything else; this is only the field people actually change.
 */

import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { useUpdateAgentConfig } from '@/hooks/projects/use-agent-config';
import { cn } from '@/lib/utils';
import type { AcpHarness, AgentConfigBlock, RuntimeProfile } from '@kortix/sdk/projects-client';
import { useQueryClient } from '@tanstack/react-query';

import { ACP_HARNESS_ICON_PROVIDER_ID, ACP_HARNESS_LABELS } from './runtime-profile-options';

/** The brand mark for a coding agent — a logo, not a status tile, so it drops
 *  the tinted background the design system uses for state icons. */
export function CodingAgentLogo({
  harness,
  className,
}: {
  harness: AcpHarness;
  className?: string;
}) {
  return (
    <ProviderLogo
      providerID={ACP_HARNESS_ICON_PROVIDER_ID[harness]}
      size="large"
      className={cn('size-5 shrink-0 rounded-none bg-transparent dark:bg-transparent', className)}
    />
  );
}

/**
 * One option per DECLARED PROFILE, not per harness. Normally those are the same
 * list — one profile each — so it reads as four brands. A project that really
 * declared two profiles on one harness gets both, disambiguated by the slug,
 * because picking between them is the only situation where the slug carries
 * information.
 */
function optionLabel(name: string, profile: RuntimeProfile): string {
  const label = ACP_HARNESS_LABELS[profile.harness];
  return name === profile.harness ? label : `${label} · ${name}`;
}

export function AgentCodingAgentSelect({
  projectId,
  agentName,
  block,
  runtimes,
  disabled = false,
}: {
  projectId: string;
  agentName: string;
  /** The agent's current config block — merged into, never replaced. */
  block: AgentConfigBlock;
  runtimes: Record<string, RuntimeProfile>;
  disabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const update = useUpdateAgentConfig(projectId, agentName);
  const entries = Object.entries(runtimes);

  const onSelect = async (name: string) => {
    const profile = runtimes[name];
    if (!profile) return;
    const next: AgentConfigBlock = { ...block, runtime: name };
    // Only OpenCode nests a second-level agent name inside the harness —
    // carrying one across to a harness with no such concept writes a block the
    // manifest validator rejects.
    if (profile.harness !== 'opencode') delete next.agent;
    try {
      await update.mutateAsync(next);
      successToast(`${agentName} now runs on ${ACP_HARNESS_LABELS[profile.harness]}`);
      await queryClient.invalidateQueries({ queryKey: ['project-config', projectId] });
    } catch (error) {
      errorToast((error as Error)?.message || "Couldn't switch coding agent");
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Select
        value={block.runtime ?? ''}
        onValueChange={(name) => void onSelect(name)}
        disabled={disabled || update.isPending || entries.length === 0}
      >
        <SelectTrigger
          aria-label={`Coding agent for ${agentName}`}
          variant="popover"
          className="h-8 w-full"
        >
          <SelectValue placeholder="Choose a coding agent" />
        </SelectTrigger>
        <SelectContent>
          {entries.map(([name, profile]) => (
            <SelectItem key={name} value={name}>
              <span className="flex items-center gap-2">
                <CodingAgentLogo harness={profile.harness} className="size-4" />
                {optionLabel(name, profile)}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
    </div>
  );
}

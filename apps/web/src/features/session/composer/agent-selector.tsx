'use client';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';
import type { Agent } from '@kortix/sdk/react';
import { isMetaAgentName } from '@kortix/shared';
import { CaretDownIcon, Check, FolderSimpleIcon as MetaFolder } from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

export function AgentSelector({
  agents,
  selectedAgent,
  onSelect,
  disabled = false,
  triggerLabelClassName,
}: {
  agents: Agent[];
  selectedAgent: string | null;
  onSelect: (agentName: string | null) => void;
  disabled?: boolean;
  triggerLabelClassName?: string;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [flash, setFlash] = useState(false);
  const prevAgentRef = useRef(selectedAgent);

  const primaryAgents = useMemo(
    () => agents.filter((a) => !a.hidden && a.mode !== 'subagent'),
    [agents],
  );

  useEffect(() => {
    if (prevAgentRef.current !== selectedAgent && prevAgentRef.current !== null) {
      setFlash(true);
      const timer = setTimeout(() => setFlash(false), 400);
      return () => clearTimeout(timer);
    }
    prevAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  useEffect(() => {
    prevAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const filteredPrimary = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return primaryAgents;
    return primaryAgents.filter(
      (a) => a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q),
    );
  }, [primaryAgents, search]);

  const filteredMeta = useMemo(
    () => filteredPrimary.filter((a) => isMetaAgentName(a.name)),
    [filteredPrimary],
  );
  const filteredProject = useMemo(
    () => filteredPrimary.filter((a) => !isMetaAgentName(a.name)),
    [filteredPrimary],
  );

  const currentAgent = primaryAgents.find((a) => a.name === selectedAgent) || primaryAgents[0];
  const displayName = currentAgent?.name || 'Agent';
  const metaSelected = isMetaAgentName(currentAgent?.name);

  const renderAgentItem = (agent: Agent, meta: boolean) => {
    const isSelected =
      selectedAgent === agent.name || (!selectedAgent && agent === primaryAgents[0]);
    return (
      <CommandItem
        key={agent.name}
        value={`agent-${agent.name}`}
        className={isSelected ? 'bg-foreground/[0.06]' : undefined}
        onSelect={() => {
          if (disabled) return;
          onSelect(agent.name);
          setOpen(false);
        }}
      >
        {meta && (
          <span className="text-muted-foreground/80 flex size-4 shrink-0 items-center justify-center self-start pt-1">
            <MetaFolder className="size-3.5" weight="fill" />
          </span>
        )}
        <div className="min-w-0 flex-1 py-0.5">
          <div
            className={cn(
              'truncate text-sm leading-tight capitalize',
              isSelected ? 'text-foreground font-semibold' : 'text-foreground/90 font-medium',
            )}
          >
            {agent.name}
          </div>
          {agent.description && (
            <p className="text-muted-foreground/55 mt-1 truncate text-xs leading-snug">
              {agent.description}
            </p>
          )}
        </div>
        {isSelected && <Check className="text-foreground shrink-0" />}
      </CommandItem>
    );
  };

  return (
    <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
      <Hint
        side="top"
        className="max-w-[240px]"
        label={
          disabled ? (
            <p>
              {
                "This agent is set when the session starts and can't be changed here. Start a new session to use a different agent."
              }
            </p>
          ) : (
            <p className="mr-1.5 flex items-center gap-1">
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line224JsxTextSwitchAgent')}
              <Kbd>Tab</Kbd>
            </p>
          )
        }
      >
        <CommandPopoverTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-foreground/70 rounded-full"
          >
            {metaSelected && <MetaFolder className="size-3.5 shrink-0" weight="fill" />}
            <span className={cn('max-w-[100px] truncate', triggerLabelClassName)}>
              {displayName}
            </span>
            <CaretDownIcon className={cn('size-3', open && 'rotate-180')} />
          </Button>
        </CommandPopoverTrigger>
      </Hint>

      <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[300px]">
        <CommandInput
          compact
          placeholder={tHardcodedUi.raw(
            'componentsSessionSessionChatInput.line231JsxAttrPlaceholderSearchAgents',
          )}
          value={search}
          onValueChange={setSearch}
        />

        <CommandList className="max-h-[320px]">
          {filteredMeta.length > 0 && (
            <CommandGroup heading="Platform" forceMount>
              {filteredMeta.map((agent) => renderAgentItem(agent, true))}
            </CommandGroup>
          )}

          {/* Project agents */}
          {filteredProject.length > 0 && (
            <CommandGroup heading="Agents" forceMount>
              {filteredProject.map((agent) => renderAgentItem(agent, false))}
            </CommandGroup>
          )}

          {/* No results */}
          {filteredPrimary.length === 0 && search.trim() && (
            <div className="text-muted-foreground/50 py-8 text-center text-xs">
              {tHardcodedUi.raw(
                'componentsSessionSessionChatInput.line273JsxTextNoAgentsMatchLdquo',
              )}
              {search.trim()}
              {tHardcodedUi.raw('componentsSessionSessionChatInput.line273JsxTextRdquo')}
            </div>
          )}
        </CommandList>
      </CommandPopoverContent>
    </CommandPopover>
  );
}

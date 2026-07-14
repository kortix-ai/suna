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
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { harnessPresentation, type KortixHarness } from '@kortix/sdk/react';
import type { HarnessAuthKind } from '@kortix/sdk';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { COMPOSER_PILL_ACTIVE_CLASS, COMPOSER_PILL_TRIGGER_CLASS } from './composer-pill';
import {
  connectionContextLine,
  connectionGroupLabel,
  defaultOptionCopy,
  harnessSubscriptionCopy,
  isSubscriptionConnection,
  shouldShowModelSearch,
} from './harness-model-selector-helpers';
import { useModelConnectionGate } from './use-model-connection-gate';

export { harnessSubscriptionCopy };

export interface HarnessModelSelectorProps {
  /**
   * Pre-session composers exclude 'opencode' (it uses the gateway catalog via
   * {@link ModelSelector} instead). A live ACP session renders every harness —
   * including opencode — through this component, since a live session's model
   * pill is driven by the ACP session's own config options, not the gateway
   * catalog.
   */
  harness: KortixHarness;
  selectedModel: string | null;
  onSelect: (model: string | null) => void;
  presets?: Array<{ id: string; name: string; source: string }>;
  connectionLabel?: string | null;
  /** Resolved auth-kind for the active connection — drives the subscription
   *  "Models managed by …" copy and the "via …" context header. */
  connectionKind?: HarnessAuthKind | null;
  /** Whether this harness/connection accepts a free-text model id (from
   *  `composer-capabilities.model.custom_allowed`). Defaults to `true` so
   *  callers that don't yet thread the flag keep today's behavior. */
  customAllowed?: boolean;
  disabled?: boolean;
}

/**
 * Model selection for harness-owned runtimes. Unlike OpenCode, Claude Code,
 * Codex, and Pi do not consume the gateway provider catalog. Their safe common
 * contract is: use the harness-native default, or pass one explicit model id at
 * session launch. Keeping that distinction visible prevents a gateway model
 * from leaking across harness switches.
 *
 * Subscription-backed harnesses (Claude Code, Codex) render a deliberately
 * minimal popover — default option, "Models managed by …" note, optional
 * custom-ID input — since there is no catalog to browse. Every other
 * connection (Kortix, an API key, a custom endpoint) gets the full "what will
 * this agent run on" structure: a one-line resolved-connection header, the
 * recommended default pinned first with a check, the models actually usable
 * right now grouped under a human connection label, and a footer that opens
 * the Models page instead of bleeding the whole catalog into this picker.
 */
export function HarnessModelSelector({
  harness,
  selectedModel,
  onSelect,
  presets = [],
  connectionLabel,
  connectionKind,
  customAllowed = true,
  disabled = false,
}: HarnessModelSelectorProps) {
  const presentation = harnessPresentation(harness);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customModel, setCustomModel] = useState(selectedModel ?? '');
  const { openConnectProvider, modal: connectionModal } = useModelConnectionGate();

  const isSubscription = isSubscriptionConnection(connectionKind);
  const contextLine = connectionContextLine({ connectionKind, connectionLabel });
  const defaultCopy = defaultOptionCopy({ connectionKind: connectionKind ?? null, harnessLabel: presentation.label });
  const subscriptionCopy = harnessSubscriptionCopy({
    connectionKind,
    harnessLabel: presentation.label,
    connectionLabel,
  });
  const groupLabel = connectionGroupLabel({ connectionKind, connectionLabel });
  const showSearch = !isSubscription && shouldShowModelSearch(presets.length);

  const visiblePresets = useMemo(() => {
    if (isSubscription) return [];
    const q = search.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter(
      (preset) => preset.name.toLowerCase().includes(q) || preset.id.toLowerCase().includes(q),
    );
  }, [presets, search, isSubscription]);

  useEffect(() => {
    if (!open) {
      setCustomModel(selectedModel ?? '');
      setSearch('');
    }
  }, [open, selectedModel]);

  const applyCustomModel = () => {
    const next = customModel.trim();
    if (!next) return;
    onSelect(next);
    setOpen(false);
  };

  const handleManageModels = () => {
    setOpen(false);
    openConnectProvider('models');
  };

  const triggerLabel = selectedModel || defaultCopy.label;

  return (
    <>
      {connectionModal}
      <CommandPopover open={open} onOpenChange={(next) => setOpen(disabled ? false : next)}>
        <Hint
          side="top"
          label={`Choose the model ${presentation.label} launches with`}
          className="max-w-64 text-xs"
        >
          <CommandPopoverTrigger>
            <button
              type="button"
              aria-label={`${presentation.label} model picker`}
              aria-disabled={disabled || undefined}
              data-testid="harness-model-selector"
              data-harness={harness}
              className={cn(
                COMPOSER_PILL_TRIGGER_CLASS,
                open && COMPOSER_PILL_ACTIVE_CLASS,
                disabled && 'cursor-not-allowed opacity-70',
              )}
            >
              <span className="max-w-[150px] truncate">{triggerLabel}</span>
              <ChevronDown
                className={cn(
                  'size-3 shrink-0 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CommandPopoverTrigger>
        </Hint>

        <CommandPopoverContent side="top" align="start" sideOffset={8} className="w-[340px]">
          {contextLine ? (
            <div className="text-muted-foreground border-b px-4 py-2 text-xs">{contextLine}</div>
          ) : null}

          <CommandList className="max-h-[300px]">
            <CommandGroup forceMount>
              <CommandItem
                value={`${harness}-default-model`}
                data-testid="harness-model-default"
                className={!selectedModel ? 'bg-primary/[0.06]' : undefined}
                onSelect={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                <div className="min-w-0 flex-1 py-0.5">
                  <p className="text-sm font-medium">{defaultCopy.label}</p>
                  <p className="text-muted-foreground mt-1 text-xs">{defaultCopy.subtitle}</p>
                </div>
                {!selectedModel ? <Check className="text-foreground size-4 shrink-0" /> : null}
              </CommandItem>
            </CommandGroup>

            {isSubscription ? (
              subscriptionCopy ? (
                <div data-testid="harness-model-subscription-note" className="px-4 py-3">
                  <p className="text-foreground text-sm font-medium">{subscriptionCopy.title}</p>
                  <p className="text-muted-foreground mt-1 text-xs">{subscriptionCopy.subtitle}</p>
                </div>
              ) : null
            ) : presets.length > 0 ? (
              <>
                {showSearch ? (
                  <CommandInput
                    compact
                    placeholder="Search models…"
                    value={search}
                    onValueChange={setSearch}
                  />
                ) : null}
                <CommandGroup heading={groupLabel} forceMount>
                  {visiblePresets.map((preset) => (
                    <CommandItem
                      key={preset.id}
                      value={`${preset.name} ${preset.id}`}
                      data-testid="harness-model-preset"
                      data-model={preset.id}
                      className={selectedModel === preset.id ? 'bg-primary/[0.06]' : undefined}
                      onSelect={() => {
                        onSelect(preset.id);
                        setOpen(false);
                      }}
                    >
                      <div className="min-w-0 flex-1 py-0.5">
                        <p className="truncate text-sm font-medium">{preset.name}</p>
                        <p className="text-muted-foreground mt-1 truncate text-xs">{preset.id}</p>
                      </div>
                      {selectedModel === preset.id ? (
                        <Check className="text-foreground size-4 shrink-0" />
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>

          {customAllowed && (
            <div className="border-t px-3 py-3">
              <label className="text-xs font-medium" htmlFor={`${harness}-custom-model`}>
                Custom model ID
              </label>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  id={`${harness}-custom-model`}
                  data-testid="harness-model-custom-input"
                  variant="popover"
                  size="xs"
                  value={customModel}
                  placeholder={presentation.customModelPlaceholder}
                  onChange={(event) => setCustomModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      applyCustomModel();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="shrink-0 transition-transform active:scale-[0.96]"
                  disabled={!customModel.trim()}
                  onClick={applyCustomModel}
                >
                  Apply
                </Button>
              </div>
            </div>
          )}

          {!isSubscription && (
            <button
              type="button"
              onClick={handleManageModels}
              className="text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] flex w-full items-center gap-2 border-t px-4 py-2.5 text-xs font-medium transition-colors duration-200"
            >
              <SlidersHorizontal className="size-3.5 shrink-0" />
              Manage models
            </button>
          )}
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}

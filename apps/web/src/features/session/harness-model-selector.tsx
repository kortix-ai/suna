'use client';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandItemHoverCard,
  CommandList,
  CommandPopover,
  CommandPopoverContent,
  CommandPopoverTrigger,
} from '@/components/ui/command';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { HarnessAuthKind } from '@kortix/sdk';
import { harnessPresentation, type KortixHarness } from '@kortix/sdk/react';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';

import { COMPOSER_PILL_ACTIVE_CLASS, COMPOSER_PILL_TRIGGER_CLASS } from './composer-pill';
import {
  defaultOptionCopy,
  filterHarnessPresets,
  harnessSubscriptionCopy,
  isSubscriptionConnection,
  presetProviderTag,
  shouldShowModelSearch,
} from './harness-model-selector-helpers';
import { useModelConnectionGate } from './use-model-connection-gate';

export { harnessSubscriptionCopy };

/** Most rows a popover list can mount before opening/typing visibly stutters —
 *  everything past the cap stays reachable through search. */
const RENDERED_PRESET_CAP = 50;

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
 * The popover is deliberately plain (2026-07-21 simplification pass — no
 * connection jargon, one aligned column): search on top when the list is
 * long, "Automatic" pinned first, one-line model rows, and a quiet footer
 * holding the expert paths (custom model ID behind a disclosure, Manage
 * models). Subscription-backed harnesses (Claude Code, Codex) have no catalog
 * to browse, so they render just the default row + a "Models managed by …"
 * note over the same footer.
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
  const [customOpen, setCustomOpen] = useState(false);
  const { openConnectProvider, modal: connectionModal } = useModelConnectionGate();

  const isSubscription = isSubscriptionConnection(connectionKind);
  const defaultCopy = defaultOptionCopy({
    connectionKind: connectionKind ?? null,
    harnessLabel: presentation.label,
  });
  const subscriptionCopy = harnessSubscriptionCopy({
    connectionKind,
    harnessLabel: presentation.label,
    connectionLabel,
  });
  const showSearch = !isSubscription && shouldShowModelSearch(presets.length);

  // A gateway-backed preset list can be the entire model catalog (thousands
  // of entries — the Pi-on-Kortix case), so two guards keep this popover
  // lag-free: the search value is deferred (keystrokes never block on
  // re-filtering the full list) and the rendered rows are capped, with a
  // count row telling the user search reaches the rest.
  const deferredSearch = useDeferredValue(search);
  const { visible: visiblePresets, hiddenCount } = useMemo(() => {
    if (isSubscription) return { visible: [], hiddenCount: 0 };
    return filterHarnessPresets({
      presets,
      query: deferredSearch,
      selectedModel,
      cap: RENDERED_PRESET_CAP,
    });
  }, [presets, deferredSearch, selectedModel, isSubscription]);

  useEffect(() => {
    if (!open) {
      setCustomModel(selectedModel ?? '');
      setSearch('');
      setCustomOpen(false);
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
    openConnectProvider();
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
              <span className="max-w-[92px] truncate sm:max-w-[150px]">{triggerLabel}</span>
              <ChevronDown
                className={cn(
                  'size-3 shrink-0 opacity-50 transition-transform duration-200',
                  open && 'rotate-180',
                )}
              />
            </button>
          </CommandPopoverTrigger>
        </Hint>

        <CommandPopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="bg-sidebar text-sidebar-foreground hover:text-foreground border-border w-[340px] rounded-md border shadow-xs"
        >
          {showSearch ? (
            <CommandInput
              compact
              placeholder="Search models…"
              value={search}
              onValueChange={setSearch}
            />
          ) : null}

          <CommandList className="max-h-[300px]">
            <CommandGroup forceMount>
              {/* Pinned first; steps aside while the user is searching — a
                  query means they already chose not-auto. One line like every
                  model row; the hover card explains who picks the model. */}
              {!search.trim() && (
                <CommandItemHoverCard
                  content={
                    <div data-testid="harness-model-default-hover-card">
                      <p className="text-sm font-medium">{defaultCopy.label}</p>
                      <p className="text-muted-foreground mt-1 text-xs leading-snug text-pretty">
                        {defaultCopy.subtitle}
                      </p>
                    </div>
                  }
                >
                  <CommandItem
                    value={`${harness}-default-model`}
                    data-testid="harness-model-default"
                    className={!selectedModel ? 'bg-primary/[0.06]' : undefined}
                    onSelect={() => {
                      onSelect(null);
                      setOpen(false);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {defaultCopy.label}
                    </span>
                    {!selectedModel ? <Check className="text-foreground size-4 shrink-0" /> : null}
                  </CommandItem>
                </CommandItemHoverCard>
              )}

              {!isSubscription &&
                visiblePresets.map((preset) => {
                  const providerTag = presetProviderTag(preset);
                  return (
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
                      <span className="min-w-0 flex-1 truncate text-sm">{preset.name}</span>
                      {providerTag ? (
                        <span className="text-muted-foreground/60 shrink-0 text-xs">
                          {providerTag}
                        </span>
                      ) : null}
                      {selectedModel === preset.id ? (
                        <Check className="text-foreground size-4 shrink-0" />
                      ) : null}
                    </CommandItem>
                  );
                })}

              {!isSubscription && hiddenCount > 0 && (
                <div
                  data-testid="harness-model-hidden-count"
                  className="text-muted-foreground/60 px-2 pt-1 pb-2 text-xs"
                >
                  {hiddenCount.toLocaleString()} more — search to find them
                </div>
              )}
            </CommandGroup>

            {isSubscription && subscriptionCopy ? (
              <div data-testid="harness-model-subscription-note" className="px-3.5 pt-1 pb-3">
                <p className="text-foreground text-sm font-medium">{subscriptionCopy.title}</p>
                <p className="text-muted-foreground mt-1 text-xs">{subscriptionCopy.subtitle}</p>
              </div>
            ) : null}
          </CommandList>

          {(customAllowed || !isSubscription) &&
            (customOpen ? (
              <div className="flex items-center gap-2 border-t px-3.5 py-2.5">
                <Input
                  id={`${harness}-custom-model`}
                  data-testid="harness-model-custom-input"
                  variant="popover"
                  size="xs"
                  autoFocus
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
            ) : (
              <div className="text-muted-foreground flex items-center border-t text-xs font-medium">
                {customAllowed && (
                  <button
                    type="button"
                    data-testid="harness-model-custom-toggle"
                    onClick={() => setCustomOpen(true)}
                    className="hover:text-foreground hover:bg-foreground/[0.04] flex-1 px-3.5 py-2.5 text-left transition-colors duration-200"
                  >
                    Custom model ID…
                  </button>
                )}
                {!isSubscription && (
                  <button
                    type="button"
                    onClick={handleManageModels}
                    className="hover:text-foreground hover:bg-foreground/[0.04] flex items-center gap-1.5 px-3.5 py-2.5 transition-colors duration-200"
                  >
                    <SlidersHorizontal className="size-3.5 shrink-0" />
                    Manage
                  </button>
                )}
              </div>
            ))}
        </CommandPopoverContent>
      </CommandPopover>
    </>
  );
}

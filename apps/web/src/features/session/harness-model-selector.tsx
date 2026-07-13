'use client';

import { Button } from '@/components/ui/button';
import {
  CommandGroup,
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
import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface HarnessModelSelectorProps {
  harness: Exclude<KortixHarness, 'opencode'>;
  selectedModel: string | null;
  onSelect: (model: string | null) => void;
  presets?: Array<{ id: string; name: string; source: string }>;
  connectionLabel?: string | null;
  disabled?: boolean;
}

/**
 * Model selection for harness-owned runtimes. Unlike OpenCode, Claude Code,
 * Codex, and Pi do not consume the gateway provider catalog. Their safe common
 * contract is: use the harness-native default, or pass one explicit model id at
 * session launch. Keeping that distinction visible prevents a gateway model
 * from leaking across harness switches.
 */
export function HarnessModelSelector({
  harness,
  selectedModel,
  onSelect,
  presets = [],
  connectionLabel,
  disabled = false,
}: HarnessModelSelectorProps) {
  const presentation = harnessPresentation(harness);
  const [open, setOpen] = useState(false);
  const [customModel, setCustomModel] = useState(selectedModel ?? '');

  useEffect(() => {
    if (!open) setCustomModel(selectedModel ?? '');
  }, [open, selectedModel]);

  const applyCustomModel = () => {
    const next = customModel.trim();
    if (!next) return;
    onSelect(next);
    setOpen(false);
  };

  return (
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
              'text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[color,background-color,transform] duration-200 active:scale-[0.96]',
              open && 'bg-primary/[0.06] text-foreground',
              disabled && 'cursor-not-allowed opacity-70',
            )}
          >
            <span className="max-w-[150px] truncate">
              {selectedModel || `${presentation.shortLabel} default`}
            </span>
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
        <div className="border-b px-4 py-3">
          <p className="text-balance text-sm font-medium">{presentation.label} model</p>
          <p className="text-muted-foreground mt-1 text-pretty text-xs">
            Keep the native default, choose an authoritative preset, or pass a model identifier to this session only.
          </p>
        </div>
        <CommandList className="max-h-[300px]">
          <CommandGroup heading="Selection" forceMount>
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
                <p className="text-sm font-medium">Harness default</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Uses the model configured by {presentation.label} and its active auth route.
                </p>
              </div>
              {!selectedModel ? <Check className="text-foreground size-4 shrink-0" /> : null}
            </CommandItem>
          </CommandGroup>
          {presets.length ? (
            <CommandGroup heading="Available models" forceMount>
              {presets.map((preset) => (
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
                    <p className="text-muted-foreground mt-1 truncate text-xs">
                      {connectionLabel ? `${connectionLabel} · ` : ''}{preset.id}
                    </p>
                  </div>
                  {selectedModel === preset.id ? <Check className="text-foreground size-4 shrink-0" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>

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
      </CommandPopoverContent>
    </CommandPopover>
  );
}

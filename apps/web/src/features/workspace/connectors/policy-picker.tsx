'use client';

import type { ConnectorPolicyAction } from '@kortix/sdk';
import { Check, ChevronDown } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** A per-tool permission choice. `default` means "no explicit rule — inherit". */
export type PolicyChoice = 'default' | ConnectorPolicyAction;

export const POLICY_CHOICES: { value: PolicyChoice; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'always_run', label: 'Allow' },
  { value: 'require_approval', label: 'Ask' },
  { value: 'block', label: 'Block' },
];

export const POLICY_LABEL: Record<ConnectorPolicyAction, { label: string; tint: string }> = {
  always_run: { label: 'Allow', tint: 'text-kortix-green' },
  require_approval: { label: 'Ask', tint: 'text-kortix-yellow' },
  block: { label: 'Block', tint: 'text-destructive' },
};

export function policyChoiceMeta(value: PolicyChoice): { label: string; tint: string } {
  return value === 'default'
    ? { label: 'Default', tint: 'text-muted-foreground' }
    : POLICY_LABEL[value];
}

/**
 * The one control that grants or withholds a tool. Rendered inline on every tool
 * row of the connector detail screen, so changing one tool's policy is a single
 * click instead of a trip through the pattern-rule editor.
 */
export function PermissionPicker({
  value,
  onChange,
  readOnly = false,
  label,
}: {
  value: PolicyChoice;
  onChange: (c: PolicyChoice) => void;
  readOnly?: boolean;
  /** Accessible name, when the trigger's text alone does not say what it governs. */
  label?: string;
}) {
  const meta = policyChoiceMeta(value);
  if (readOnly) {
    return (
      <span
        className={cn(
          'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium',
          meta.tint,
        )}
      >
        {meta.label}
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            'hover:bg-muted inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors',
            meta.tint,
          )}
        >
          {meta.label}
          <ChevronDown className="size-3 opacity-40" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-28">
        {POLICY_CHOICES.map((c) => (
          <DropdownMenuItem key={c.value} onClick={() => onChange(c.value)} className="text-xs">
            <span className={cn(c.value !== 'default' && POLICY_LABEL[c.value].tint)}>
              {c.label}
            </span>
            {c.value === value && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

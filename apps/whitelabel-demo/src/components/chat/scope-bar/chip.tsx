'use client';

/**
 * The scope-bar chip primitives: one compact popover chip, the collapsible
 * editor inside it, the apply-draft block both editing chips share, and the
 * "start a new session" action. The chip itself never mutates anything.
 */

import Loading from '@/components/ui/loading';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ChevronDown, Plus } from 'lucide-react';
import { type ReactNode } from 'react';
import { START_NEW_SESSION_ACTION } from '../scope-bar-model';

/** One compact chip. Opens a popover; the chip itself never mutates anything. */
export function ScopeChip({
  icon,
  label,
  value,
  title,
  badge,
  note,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  title: string;
  badge: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 rounded-full border border-border/70 px-2 text-[11px] font-normal text-muted-foreground"
          aria-label={`${label}: ${value}`}
        >
          {icon}
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-40 truncate text-foreground">{value}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-80 max-h-[60dvh] overflow-y-auto scrollbar-thin"
      >
        <PopoverHeader>
          <div className="flex items-center gap-2">
            <PopoverTitle>{title}</PopoverTitle>
            <Badge variant="secondary" className="text-[11px]">
              {badge}
            </Badge>
          </div>
          <PopoverDescription className="text-xs leading-relaxed">
            {note}
          </PopoverDescription>
        </PopoverHeader>
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function ScopeEditor({
  label,
  show = true,
  children,
}: {
  label: string;
  show?: boolean;
  children: ReactNode;
}) {
  if (!show) return null;
  return (
    <Collapsible className="mt-3 border-t border-border pt-3">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-between px-1 text-xs font-normal text-muted-foreground"
        >
          {label}
          <ChevronDown className="size-3.5" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-2.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The apply block both editing chips share: same button, different guarantee —
 * the caveat copy is the caller's, because secrets and connections do NOT
 * take effect the same way.
 */
export function ApplyDraft({
  show,
  pending,
  disabled = false,
  onApply,
  caveat,
}: {
  show: boolean;
  pending: boolean;
  disabled?: boolean;
  onApply: () => void;
  caveat: string;
}) {
  if (!show) return null;
  return (
    <div className="mt-2 space-y-1.5 border-t border-border pt-2">
      <Button
        size="sm"
        className="w-full"
        disabled={pending || disabled}
        onClick={onApply}
      >
        {pending ? 'Applying…' : 'Apply to this session'}
      </Button>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{caveat}</p>
    </div>
  );
}

/** Starts a session with the draft — or says why it would be refused. */
export function StartWithScope({
  issues,
  pending,
  onStart,
}: {
  issues: string[];
  pending: boolean;
  onStart: () => void;
}) {
  return (
    <div className="mt-3 space-y-1.5 border-t border-border pt-3">
      {/* A refused allowlist can never be edited afterwards, so starting a
          session that cannot boot is not a recoverable mistake. Name it here
          instead of letting the create be the first place anyone hears it. */}
      {issues.map((issue) => (
        <p key={issue} className="text-[11px] leading-relaxed text-destructive">
          {issue}
        </p>
      ))}
      <Button
        size="sm"
        variant="secondary"
        className="h-7 w-full gap-1.5"
        disabled={pending || issues.length > 0}
        onClick={onStart}
      >
        {pending ? (
          <Loading className="size-3.5" />
        ) : (
          <Plus className="size-3.5" />
        )}
        {START_NEW_SESSION_ACTION}
      </Button>
    </div>
  );
}

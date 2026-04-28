'use client';

import Link from 'next/link';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/utils';

const ROW_BASE =
  'h-9 rounded-lg text-sm font-medium transition-colors';
const ROW_INACTIVE =
  'text-muted-foreground/80 hover:bg-muted/50 hover:text-foreground';
const ROW_ACTIVE =
  'bg-muted text-foreground';

const SUB_BASE = 'h-7 gap-2 rounded-md text-[13px] transition-colors';
const SUB_INACTIVE = 'text-muted-foreground/80 hover:bg-muted/50 hover:text-foreground';
const SUB_ACTIVE = 'bg-muted text-foreground font-medium';

export function SidebarSectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-1 mt-5 px-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/55 group-data-[collapsible=icon]:hidden">
      {label}
    </div>
  );
}

export function SidebarActionItem({
  icon: Icon,
  label,
  onClick,
  kbd,
  tooltip,
  loading,
  disabled,
  loadingIcon,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  kbd?: string;
  tooltip?: string;
  loading?: boolean;
  disabled?: boolean;
  loadingIcon?: React.ReactNode;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={tooltip ?? `${label}${kbd ? ` ${kbd}` : ''}`}
        disabled={disabled || loading}
        onClick={onClick}
        className={cn(ROW_BASE, ROW_INACTIVE, 'disabled:opacity-60')}
      >
        {loading && loadingIcon ? loadingIcon : <Icon />}
        <span>{label}</span>
        {kbd && (
          <Kbd className="ml-auto bg-transparent text-muted-foreground/55 group-data-[collapsible=icon]:hidden">
            {kbd}
          </Kbd>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function SidebarLinkItem({
  icon: Icon,
  label,
  href,
  isActive,
  kbd,
  tooltip,
}: {
  icon: LucideIcon;
  label: string;
  href: string;
  isActive?: boolean;
  kbd?: string;
  tooltip?: string;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={tooltip ?? label}
        className={cn(ROW_BASE, isActive ? ROW_ACTIVE : ROW_INACTIVE)}
      >
        <Link href={href}>
          <Icon />
          <span>{label}</span>
          {kbd && (
            <Kbd className="ml-auto bg-transparent text-muted-foreground/55 group-data-[collapsible=icon]:hidden">
              {kbd}
            </Kbd>
          )}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

type GroupId = 'projects' | 'sessions';

const GROUP_VARIANT_CLASSES: Record<GroupId, { container: string; rotate: string }> = {
  projects: {
    container: 'group/projects',
    rotate: 'group-data-[state=closed]/projects:-rotate-90',
  },
  sessions: {
    container: 'group/sessions',
    rotate: 'group-data-[state=closed]/sessions:-rotate-90',
  },
};

export function SidebarCollapsibleGroup({
  id,
  icon: Icon,
  label,
  count,
  defaultOpen = true,
  isActive,
  scrollable,
  className,
  children,
}: {
  id: GroupId;
  icon: LucideIcon;
  label: string;
  count?: number;
  defaultOpen?: boolean;
  isActive?: boolean;
  scrollable?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const variant = GROUP_VARIANT_CLASSES[id];
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={cn(
        variant.container,
        'mt-0.5 flex min-h-0 flex-col group-data-[collapsible=icon]:hidden',
        className,
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-lg px-2',
            ROW_BASE,
            isActive ? ROW_ACTIVE : ROW_INACTIVE,
          )}
        >
          <Icon className="size-4" />
          <span className="flex-1 text-left">{label}</span>
          {typeof count === 'number' && count > 0 && (
            <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground/70">
              {count}
            </span>
          )}
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground/55 transition-transform duration-200',
              variant.rotate,
            )}
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          'min-h-0 overflow-hidden',
          scrollable &&
            'data-[state=open]:max-h-[40vh] data-[state=open]:overflow-y-auto data-[state=open]:pt-1 [&::-webkit-scrollbar]:hidden',
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SidebarSubLink({
  href,
  isActive,
  indicator,
  label,
}: {
  href: string;
  isActive?: boolean;
  indicator?: React.ReactNode;
  label: string;
}) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isActive}
        className={cn(SUB_BASE, isActive ? SUB_ACTIVE : SUB_INACTIVE)}
      >
        <Link href={href}>
          {indicator}
          <span className="truncate">{label}</span>
        </Link>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}

export function SidebarGroupBody({ children }: { children: React.ReactNode }) {
  return (
    <SidebarMenuSub className="mr-0 mt-0.5 border-l-border/40 pl-3">
      {children}
    </SidebarMenuSub>
  );
}

export function SidebarGroupEmpty({ children }: { children: React.ReactNode }) {
  return <li className="px-2 py-2 text-xs text-muted-foreground/60">{children}</li>;
}

export { SidebarMenu };

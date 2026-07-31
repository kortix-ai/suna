'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MagnifyingGlassIcon as Search, XIcon as X } from '@phosphor-icons/react';

/**
 * Standardized search bar for page-level search/filter.
 * Use on workspace, service-manager, connectors, tunnel, scheduled-tasks, etc.
 */
function PageSearchBar({
  value,
  onChange,
  placeholder = 'Search...',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('group relative flex-1', className)}>
      <input
        type="text"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border-input bg-card ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring/50 h-9 w-full rounded-2xl border pr-8 pl-9 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      />
      <div className="text-muted-foreground group-focus-within:text-primary pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 transition-colors">
        <Search className="h-3.5 w-3.5" />
      </div>
      {value && (
        <Button
          onClick={() => onChange('')}
          variant="ghost"
          size="icon-xs"
          className="absolute top-1/2 right-2 -translate-y-1/2"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

export { PageSearchBar };

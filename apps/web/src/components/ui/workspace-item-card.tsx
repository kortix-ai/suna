'use client';

/**
 * Shared card used by Workspace and Marketplace pages.
 * No icons — name, kind badge, scope/meta line, description, action slot.
 */

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { SpotlightCard } from '@/components/ui/spotlight-card';

export interface WorkspaceCardItem {
  id: string;
  name: string;
  description?: string;
  /** Small badge label — Agent, Skill, Command, MCP, etc. */
  kindLabel: string;
  /** Secondary line text — scope, version, server name, etc. */
  meta?: string;
  /** Whether name should be mono (commands) */
  mono?: boolean;
}

export function WorkspaceItemCard({
  item,
  index = 0,
  onClick,
  actions,
}: {
  item: WorkspaceCardItem;
  index?: number;
  onClick?: () => void;
  /** Optional slot for buttons rendered in the bottom-right */
  actions?: React.ReactNode;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.02, 0.35) }}
    >
      <SpotlightCard className="bg-card border border-border/50 h-full">
        <div
          onClick={onClick}
          className={cn(
            'p-4 sm:p-5 flex flex-col h-full',
            onClick && 'cursor-pointer',
          )}
        >
          {/* Name row */}
          <div className="mb-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <h3
                className={cn(
                  'font-semibold text-sm text-foreground truncate',
                  item.mono && 'font-mono',
                )}
              >
                {item.name}
              </h3>
              <Badge variant="secondary" className="text-xs px-1.5 py-0 shrink-0">
                {item.kindLabel}
              </Badge>
            </div>
            {item.meta && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">
                {item.meta}
              </p>
            )}
          </div>

          {/* Description — fixed height so action row always aligns */}
          <div className="h-[34px] mb-3">
            <p className="text-xs text-muted-foreground/70 leading-relaxed line-clamp-2">
              {item.description || '\u00A0'}
            </p>
          </div>

          {actions && (
            <div className="flex justify-end">{actions}</div>
          )}
        </div>
      </SpotlightCard>
    </motion.div>
  );
}

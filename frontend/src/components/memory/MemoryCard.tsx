'use client';

import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SpotlightCard } from '@/components/ui/spotlight-card';
import type { Memory } from '@/lib/api/memory';

interface MemoryCardProps {
  memory: Memory;
  onDelete: (memoryId: string) => void;
  isDeleting?: boolean;
}

export function MemoryCard({ memory, onDelete, isDeleting }: MemoryCardProps) {
  return (
    <SpotlightCard className="group border border-border">
      <div className="p-4">
        <div className="flex items-center gap-3 justify-between">
          <div className="flex-1 min-w-0 space-y-1.5">
            <p className="text-sm font-medium text-foreground/90 leading-normal">
              {memory.content}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(memory.memory_id)}
            disabled={isDeleting}
            className="h-8 w-8 text-muted-foreground/50 opacity-0 group-hover:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </SpotlightCard>
  );
}

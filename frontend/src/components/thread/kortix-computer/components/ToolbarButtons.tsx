'use client';

import { memo } from 'react';
import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ToolbarButtonsProps {
  onClose: () => void;
  isMaximized?: boolean;
}

export const ToolbarButtons = memo(function ToolbarButtons({ 
  onClose, 
  isMaximized = false 
}: ToolbarButtonsProps) {
  return (
    <div className="flex items-center gap-0.5 p-1 rounded-full bg-muted">
      <Tooltip>
        <TooltipTrigger asChild>
          <motion.button
            onClick={onClose}
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center",
              isMaximized && "w-5 h-5",
              "text-muted-foreground hover:text-foreground hover:bg-background hover:shadow-sm",
              "transition-colors duration-150"
            )}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <X className="w-4 h-4" strokeWidth={2} />
          </motion.button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>Close</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

ToolbarButtons.displayName = 'ToolbarButtons';

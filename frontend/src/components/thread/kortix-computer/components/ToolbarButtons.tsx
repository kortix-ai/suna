'use client';

import { memo } from 'react';
import { X, Minus, Maximize2, Minimize2 } from 'lucide-react';
import { motion } from 'framer-motion';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface ToolbarButtonsProps {
  onClose: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  isMaximized?: boolean;
}

export const ToolbarButtons = memo(function ToolbarButtons({ 
  onClose, 
  onMinimize, 
  onMaximize,
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
              "text-muted-foreground hover:text-destructive hover:bg-destructive/30 hover:shadow-sm",
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

      <Tooltip>
        <TooltipTrigger asChild>
          <motion.button
            onClick={onMinimize}
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center",
              "text-muted-foreground hover:text-foreground hover:bg-background hover:shadow-sm",
              "transition-colors duration-150"
            )}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            <Minus className="w-4 h-4" strokeWidth={2} />
          </motion.button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>Minimize</span>
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <motion.button
            onClick={onMaximize}
            className={cn(
              "w-7 h-7 rounded-full flex items-center justify-center",
              "text-muted-foreground hover:text-foreground hover:bg-background hover:shadow-sm",
              "transition-colors duration-150"
            )}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5" strokeWidth={2} />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" strokeWidth={2} />
            )}
          </motion.button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <span>{isMaximized ? 'Exit Full Screen' : 'Full Screen'}</span>
        </TooltipContent>
      </Tooltip>
    </div>
  );
});

ToolbarButtons.displayName = 'ToolbarButtons';


'use client';

import React, { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

export type DialogTheme = 'warning' | 'destructive' | 'primary' | 'info';
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

interface DialogAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'outline' | 'destructive' | 'secondary' | 'ghost';
  icon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
}

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  
  icon: LucideIcon;
  title: string;
  description: string;
  theme?: DialogTheme;
  
  children?: ReactNode;
  size?: DialogSize;
  
  actions?: DialogAction[];
  
  className?: string;
  headerClassName?: string;
  contentClassName?: string;
  
  preventOutsideClick?: boolean;
}

const themeConfig = {
  warning: {
    iconContainer: 'bg-amber-100 dark:bg-amber-900 border-amber-300 dark:border-amber-900',
    iconColor: 'text-amber-600 dark:text-amber-400',
  },
  destructive: {
    iconContainer: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    iconColor: 'text-red-500 dark:text-red-400',
  },
  primary: {
    iconContainer: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    iconColor: 'text-blue-500 dark:text-blue-400',
  },
  info: {
    iconContainer: 'bg-secondary/10 border-secondary/20',
    iconColor: 'text-secondary',
  },
};

const sizeConfig = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-5xl',
};

export const UpgradeDialog: React.FC<UpgradeDialogProps> = ({
  open,
  onOpenChange,
  icon: Icon,
  title,
  description,
  theme = 'warning',
  children,
  size = 'md',
  actions = [],
  className,
  headerClassName,
  contentClassName,
  preventOutsideClick = false,
}) => {
  const themeStyles = themeConfig[theme];
  const sizeClass = sizeConfig[size];

  const handleOutsideClick = preventOutsideClick 
    ? (e: Event) => e.preventDefault() 
    : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className={cn(sizeClass, 'h-auto overflow-y-auto', className)}
        onPointerDownOutside={handleOutsideClick}
      >
        <DialogHeader className={headerClassName}>
          <div className="flex items-center gap-2">
            <div className={cn(
              'flex h-8 w-8 items-center justify-center rounded-full border',
              themeStyles.iconContainer
            )}>
              <Icon className={cn('h-4 w-4', themeStyles.iconColor)} />
            </div>
            <DialogTitle className="text-lg font-semibold">
              {title}
            </DialogTitle>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            {description}
          </DialogDescription>
        </DialogHeader>

        {children && (
          <div className={cn('space-y-4', contentClassName)}>
            {children}
          </div>
        )}

        {actions.length > 0 && (
          <DialogFooter className="flex gap-2">
            {actions.map((action, index) => {
              const ActionIcon = action.icon;
              return (
                <Button
                  key={index}
                  variant={action.variant || 'default'}
                  onClick={action.onClick}
                  disabled={action.disabled || action.loading}
                  className="flex items-center gap-2"
                >
                  {action.loading && (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  )}
                  {ActionIcon && !action.loading && <ActionIcon className="h-4 w-4" />}
                  {action.label}
                </Button>
              );
            })}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}; 
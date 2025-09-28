'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Check, Dot, Star, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export interface DocsBulletItemProps extends React.HTMLAttributes<HTMLLIElement> {
  title?: string;
  description?: string;
  icon?: LucideIcon;
  badge?: string;
  badgeVariant?: 'default' | 'secondary' | 'destructive' | 'outline';
  variant?: 'default' | 'check' | 'star' | 'arrow' | 'dot';
  size?: 'sm' | 'default' | 'lg';
}

export interface DocsBulletsProps extends React.HTMLAttributes<HTMLUListElement> {
  variant?: 'default' | 'check' | 'star' | 'arrow' | 'dot';
  size?: 'sm' | 'default' | 'lg';
  spacing?: 'tight' | 'default' | 'loose';
  ordered?: boolean;
}

export const DocsBulletItem = React.forwardRef<HTMLLIElement, DocsBulletItemProps>(
  ({
    title,
    description,
    icon: Icon,
    badge,
    badgeVariant = 'secondary',
    variant = 'default',
    size = 'default',
    className,
    children,
    ...props
  }, ref) => {
    const getDefaultIcon = () => {
      switch (variant) {
        case 'check':
          return Check;
        case 'star':
          return Star;
        case 'arrow':
          return ArrowRight;
        case 'dot':
          return Dot;
        default:
          return null;
      }
    };

    const DisplayIcon = Icon || getDefaultIcon();

    const iconSizes = {
      sm: 'h-4 w-4',
      default: 'h-5 w-5',
      lg: 'h-6 w-6'
    };

    const titleSizes = {
      sm: 'text-sm',
      default: 'text-base',
      lg: 'text-lg'
    };

    const descriptionSizes = {
      sm: 'text-xs',
      default: 'text-sm',
      lg: 'text-base'
    };

    const iconColors = {
      default: 'text-muted-foreground',
      check: 'text-green-600 dark:text-green-400',
      star: 'text-yellow-600 dark:text-yellow-400',
      arrow: 'text-primary',
      dot: 'text-muted-foreground'
    };

    return (
      <li
        ref={ref}
        className={cn("flex gap-3 items-start", className)}
        {...props}
      >
        {DisplayIcon && (
          <div className="flex-shrink-0 mt-0.5">
            <DisplayIcon 
              className={cn(
                iconSizes[size],
                iconColors[variant]
              )} 
            />
          </div>
        )}
        
        <div className="flex-1 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            {title && (
              <span className={cn(
                "font-medium text-foreground",
                titleSizes[size]
              )}>
                {title}
              </span>
            )}
            
            {badge && (
              <Badge variant={badgeVariant} className="h-5 text-xs">
                {badge}
              </Badge>
            )}
          </div>
          
          {description && (
            <p className={cn(
              "text-muted-foreground leading-relaxed",
              descriptionSizes[size]
            )}>
              {description}
            </p>
          )}
          
          {children && (
            <div className="text-muted-foreground">
              {children}
            </div>
          )}
        </div>
      </li>
    );
  }
);

DocsBulletItem.displayName = 'DocsBulletItem';

export const DocsBullets = React.forwardRef<HTMLUListElement, DocsBulletsProps>(
  ({
    variant = 'default',
    size = 'default',
    spacing = 'default',
    ordered = false,
    className,
    children,
    ...props
  }, ref) => {
    const spacingClasses = {
      tight: 'space-y-2',
      default: 'space-y-3',
      loose: 'space-y-4'
    };

    // Clone children to pass down variant and size props
    const enhancedChildren = React.Children.map(children, (child) => {
      if (React.isValidElement(child) && child.type === DocsBulletItem) {
        return React.cloneElement(child, {
          variant: child.props.variant || variant,
          size: child.props.size || size,
          ...child.props
        });
      }
      return child;
    });

    const Component = ordered ? 'ol' : 'ul';
    const listStyleClass = ordered ? 'list-decimal pl-6' : 'list-none';

    return (
      <Component
        ref={ref as any}
        className={cn(
          listStyleClass,
          spacingClasses[spacing],
          className
        )}
        {...props}
      >
        {enhancedChildren}
      </Component>
    );
  }
);

DocsBullets.displayName = 'DocsBullets'; 
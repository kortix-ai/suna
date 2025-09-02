'use client';

import * as React from 'react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export interface DocsCardAction {
  label: string;
  href?: string;
  onClick?: () => void;
  variant?: 'default' | 'secondary' | 'outline' | 'ghost';
  icon?: LucideIcon;
  external?: boolean;
}

export interface DocsCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'content'> {
  title: string;
  description?: string;
  content?: React.ReactNode;
  icon?: LucideIcon;
  badge?: string;
  badgeVariant?: 'default' | 'secondary' | 'destructive' | 'outline';
  image?: string;
  imageAlt?: string;
  actions?: DocsCardAction[];
  hover?: boolean;
  clickable?: boolean;
  size?: 'sm' | 'default' | 'lg';
  variant?: 'default' | 'outline' | 'ghost';
  orientation?: 'vertical' | 'horizontal';
}

export const DocsCard = React.forwardRef<HTMLDivElement, DocsCardProps>(
  ({
    title,
    description,
    content,
    icon: Icon,
    badge,
    badgeVariant = 'secondary',
    image,
    imageAlt,
    actions = [],
    hover = false,
    clickable = false,
    size = 'default',
    variant = 'default',
    orientation = 'vertical',
    className,
    onClick,
    ...props
  }, ref) => {
    const cardSizes = {
      sm: 'p-4',
      default: 'p-6',
      lg: 'p-8'
    };

    const titleSizes = {
      sm: 'text-base',
      default: 'text-lg',
      lg: 'text-xl'
    };

    const descriptionSizes = {
      sm: 'text-xs',
      default: 'text-sm',
      lg: 'text-base'
    };

    const iconSizes = {
      sm: 'h-5 w-5',
      default: 'h-6 w-6',
      lg: 'h-8 w-8'
    };

    const cardVariants = {
      default: '',
      outline: 'border-2',
      ghost: 'border-0 shadow-none bg-transparent'
    };

    return (
      <Card
        ref={ref}
        className={cn(
          "group relative p-0",
          cardVariants[variant],
          hover && "transition-all duration-200 hover:shadow-lg hover:-translate-y-1",
          clickable && "cursor-pointer hover:opacity-80 transition-opacity",
          orientation === 'horizontal' && "flex flex-row",
          className
        )}
        onClick={onClick}
        {...props}
      >
        {image && (
          <div className={cn(
            "overflow-hidden",
            orientation === 'vertical' ? "rounded-t-lg" : "rounded-l-lg w-48 flex-shrink-0"
          )}>
            <img
              src={image}
              alt={imageAlt || title}
              className="w-full h-full object-cover transition-transform group-hover:scale-105"
            />
          </div>
        )}

        <div className={cn(
          "flex flex-col flex-1",
          orientation === 'horizontal' ? "justify-between" : ""
        )}>
          <CardHeader className={cardSizes[size]}>
            <div className="flex items-start justify-between">
              <div className="space-y-2 flex-1">
                {badge && (
                  <Badge variant={badgeVariant} className="w-fit">
                    {badge}
                  </Badge>
                )}
                
                <div className="flex items-center gap-3">
                  {Icon && (
                    <div className="flex-shrink-0">
                      <Icon className={cn(iconSizes[size], "text-primary")} />
                    </div>
                  )}
                  <CardTitle className={cn(
                    "font-semibold leading-tight",
                    titleSizes[size]
                  )}>
                    {title}
                  </CardTitle>
                </div>
              </div>
              
              {clickable && (
                <ArrowRight className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground" />
              )}
            </div>
            
            {description && (
              <CardDescription className={cn(
                "leading-relaxed",
                descriptionSizes[size]
              )}>
                {description}
              </CardDescription>
            )}
          </CardHeader>

          {content && (
            <CardContent className={cn("pt-0", cardSizes[size])}>
              {content}
            </CardContent>
          )}

          {actions.length > 0 && (
            <CardFooter className={cn("pt-0", cardSizes[size])}>
              <div className="flex flex-wrap gap-2">
                {actions.map((action, index) => (
                  <Button
                    key={index}
                    variant={action.variant || 'default'}
                    size={size}
                    onClick={action.onClick}
                    asChild={!!action.href}
                    className="h-auto"
                  >
                    {action.href ? (
                      <a href={action.href} className="flex items-center gap-2">
                        {action.icon && <action.icon className="h-4 w-4" />}
                        {action.label}
                        {action.external && <ExternalLink className="h-3 w-3" />}
                      </a>
                    ) : (
                      <>
                        {action.icon && <action.icon className="h-4 w-4" />}
                        {action.label}
                        {action.external && <ExternalLink className="h-3 w-3" />}
                      </>
                    )}
                  </Button>
                ))}
              </div>
            </CardFooter>
          )}
        </div>
      </Card>
    );
  }
);

DocsCard.displayName = 'DocsCard'; 
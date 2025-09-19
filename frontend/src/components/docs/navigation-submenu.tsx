'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DocsNavigationItem } from './types';

interface NavigationSubmenuProps {
  item: DocsNavigationItem;
  level?: number;
  onNavigate?: (item: DocsNavigationItem) => void;
}

export const NavigationSubmenu = ({ 
  item, 
  level = 0, 
  onNavigate 
}: NavigationSubmenuProps) => {
  const [isExpanded, setIsExpanded] = useState(item.defaultExpanded ?? false);
  const hasChildren = item.children && item.children.length > 0;
  const paddingLeft = level * 12; // 12px per level

  const handleClick = () => {
    if (hasChildren) {
      setIsExpanded(!isExpanded);
    }
    
    if (item.href && onNavigate) {
      onNavigate(item);
    }
  };

  return (
    <div className="space-y-1">
      <Button
        variant="ghost"
        onClick={handleClick}
        className={cn(
          "w-full justify-start h-auto p-3 font-normal",
          hasChildren && "cursor-pointer",
          !hasChildren && item.href && "hover:bg-accent"
        )}
        style={{ paddingLeft: `${12 + paddingLeft}px` }}
      >
        {hasChildren && (
          <ChevronRight 
            className={cn(
              "mr-2 h-4 w-4 transition-transform",
              isExpanded && "rotate-90"
            )} 
          />
        )}
        
        {item.icon && (
          <item.icon className="mr-3 h-4 w-4" />
        )}
        
        <span className="flex-1 text-left text-sm">
          {item.title}
        </span>
        
        {item.badge && (
          <Badge variant="secondary" className="ml-2 h-5 text-xs">
            {item.badge}
          </Badge>
        )}
      </Button>

      {hasChildren && isExpanded && (
        <div className="space-y-1">
          {item.children?.map((child) => (
            <NavigationSubmenu
              key={child.id}
              item={child}
              level={level + 1}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}; 
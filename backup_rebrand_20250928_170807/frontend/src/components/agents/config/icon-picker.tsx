'use client';

import React, { useState, useMemo } from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { icons } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface IconPickerProps {
  selectedIcon?: string;
  onIconSelect: (iconName: string) => void;
  iconColor?: string;
  backgroundColor?: string;
  className?: string;
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

export function IconPicker({
  selectedIcon,
  onIconSelect,
  iconColor = '#000000',
  backgroundColor = '#F3F4F6',
  className
}: IconPickerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  
  const allIconNames = useMemo(() => {
    return Object.keys(icons).map(name => toKebabCase(name)).sort();
  }, []);

  const filteredIcons = useMemo(() => {
    if (!searchQuery) return allIconNames;
    
    const query = searchQuery.toLowerCase();
    return allIconNames.filter(name => 
      name.includes(query) || 
      name.replace(/-/g, ' ').includes(query)
    );
  }, [allIconNames, searchQuery]);

  const popularIcons = [
    'bot', 'brain', 'sparkles', 'zap', 'rocket', 
    'briefcase', 'code', 'database', 'globe', 'heart',
    'lightbulb', 'message-circle', 'shield', 'star', 'user',
    'cpu', 'terminal', 'settings', 'wand-2', 'layers'
  ];

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="pb-3 shrink-0">
        <Input
          type="text"
          placeholder="Search icons..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full"
        />
      </div>
      <ScrollArea className="flex-1 rounded-lg border min-h-0">
        <div className="p-4 space-y-6">
          {!searchQuery && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Popular Icons
              </p>
              <div className="grid grid-cols-5 sm:grid-cols-8 gap-2">
                {popularIcons.map((iconName) => (
                  <button
                    key={iconName}
                    onClick={() => onIconSelect(iconName)}
                    className={cn(
                      "p-2 sm:p-3 rounded-md border transition-all hover:scale-105 flex items-center justify-center aspect-square",
                      selectedIcon === iconName
                        ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                        : "border-border hover:border-primary/60 hover:bg-accent"
                    )}
                    style={{
                      backgroundColor: selectedIcon === iconName ? backgroundColor : undefined
                    }}
                    title={iconName}
                  >
                    <DynamicIcon 
                      name={iconName as any} 
                      size={18} 
                      color={selectedIcon === iconName ? iconColor : undefined}
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {searchQuery 
                ? `Search Results (${filteredIcons.length})`
                : `All Icons (${allIconNames.length})`
              }
            </p>
            
            {filteredIcons.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                <p>No icons found matching "{searchQuery}"</p>
                <p className="text-xs mt-2">Try a different search term</p>
              </div>
            ) : (
              <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
                {filteredIcons.map((iconName) => (
                  <button
                    key={iconName}
                    onClick={() => onIconSelect(iconName)}
                    className={cn(
                      "rounded-md border transition-all hover:scale-105 flex items-center justify-center aspect-square",
                      selectedIcon === iconName
                        ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                        : "border-border hover:border-primary/60 hover:bg-accent"
                    )}
                    style={{
                      backgroundColor: selectedIcon === iconName ? backgroundColor : undefined
                    }}
                    title={iconName}
                  >
                    <DynamicIcon 
                      name={iconName as any} 
                      size={18} 
                      color={selectedIcon === iconName ? iconColor : undefined}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
} 
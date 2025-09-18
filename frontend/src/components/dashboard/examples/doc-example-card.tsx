'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface DocExampleCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
  icon?: React.ReactNode;
  templateType?: 'api' | 'readme' | 'guide' | 'schema' | 'changelog' | 'config';
  index?: number;
}

const DocumentTemplate: React.FC<{ type: DocExampleCardProps['templateType'] }> = ({ type }) => {
  switch (type) {
    case 'api':
      return (
        <div className="space-y-1.5 p-3">
          <div className="w-16 h-2 bg-muted-foreground/20 rounded-full" />
          <div className="space-y-1">
            <div className="flex gap-1">
              <div className="w-2 h-2 bg-muted-foreground/15 rounded-full" />
              <div className="w-20 h-1 bg-muted-foreground/10 rounded-full" />
            </div>
            <div className="flex gap-1">
              <div className="w-2 h-2 bg-muted-foreground/15 rounded-full" />
              <div className="w-16 h-1 bg-muted-foreground/10 rounded-full" />
            </div>
          </div>
          <div className="mt-2 space-y-0.5">
            <div className="w-full h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-5/6 h-1 bg-muted-foreground/10 rounded-full" />
          </div>
        </div>
      );
    
    case 'readme':
      return (
        <div className="space-y-1.5 p-3">
          <div className="w-20 h-2 bg-muted-foreground/20 rounded-full" />
          <div className="space-y-0.5">
            <div className="w-full h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-5/6 h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-4/5 h-1 bg-muted-foreground/10 rounded-full" />
          </div>
          <div className="space-y-0.5 mt-2">
            <div className="w-full h-1 bg-muted-foreground/5 rounded-full" />
            <div className="w-3/4 h-1 bg-muted-foreground/5 rounded-full" />
          </div>
        </div>
      );
    
    case 'guide':
      return (
        <div className="space-y-1.5 p-3">
          <div className="w-24 h-2.5 bg-muted-foreground/25 rounded-full" />
          <div className="space-y-0.5 mt-2">
            <div className="w-full h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-full h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-5/6 h-1 bg-muted-foreground/10 rounded-full" />
          </div>
          <div className="w-16 h-1.5 bg-muted-foreground/15 rounded-full mt-2" />
          <div className="space-y-0.5">
            <div className="w-4/5 h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-3/4 h-1 bg-muted-foreground/10 rounded-full" />
          </div>
        </div>
      );
    
    case 'schema':
      return (
        <div className="space-y-1.5 p-3">
          <div className="flex gap-2 items-center">
            <div className="w-24 h-2 bg-muted-foreground/20 rounded-full" />
            <div className="w-12 h-2 bg-muted-foreground/15 rounded-full ml-auto" />
          </div>
          <div className="border border-muted-foreground/10 rounded p-1.5 space-y-1">
            <div className="w-20 h-1 bg-muted-foreground/10 rounded-full" />
            <div className="space-y-0.5">
              <div className="w-full h-1 bg-muted-foreground/5 rounded-full" />
              <div className="w-5/6 h-1 bg-muted-foreground/5 rounded-full" />
            </div>
          </div>
        </div>
      );
    
    case 'changelog':
      return (
        <div className="space-y-1.5 p-3">
          <div className="flex items-center gap-2">
            <div className="w-1 h-1 bg-muted-foreground/20 rounded-full" />
            <div className="w-16 h-1.5 bg-muted-foreground/15 rounded-full" />
          </div>
          <div className="space-y-1 pl-3">
            <div className="w-20 h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-24 h-1 bg-muted-foreground/10 rounded-full" />
          </div>
          <div className="flex items-center gap-2 mt-2">
            <div className="w-1 h-1 bg-muted-foreground/20 rounded-full" />
            <div className="w-12 h-1.5 bg-muted-foreground/15 rounded-full" />
          </div>
        </div>
      );
    
    case 'config':
      return (
        <div className="space-y-1.5 p-3">
          <div className="space-y-1">
            <div className="w-20 h-1.5 bg-muted-foreground/20 rounded-full" />
            <div className="pl-2 space-y-0.5">
              <div className="w-24 h-1 bg-muted-foreground/10 rounded-full" />
              <div className="w-20 h-1 bg-muted-foreground/10 rounded-full" />
            </div>
          </div>
          <div className="space-y-1 mt-2">
            <div className="w-16 h-1.5 bg-muted-foreground/20 rounded-full" />
            <div className="pl-2">
              <div className="w-18 h-1 bg-muted-foreground/10 rounded-full" />
            </div>
          </div>
        </div>
      );
    
    default:
      return (
        <div className="space-y-1.5 p-3">
          <div className="w-16 h-2 bg-muted-foreground/20 rounded-full" />
          <div className="space-y-0.5">
            <div className="w-full h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-5/6 h-1 bg-muted-foreground/10 rounded-full" />
            <div className="w-4/5 h-1 bg-muted-foreground/10 rounded-full" />
          </div>
          <div className="w-3/4 h-1 bg-muted-foreground/5 rounded-full mt-2" />
        </div>
      );
  }
};

export function DocExampleCard({
  title,
  subtitle,
  onClick,
  icon,
  templateType = 'readme',
  index = 0
}: DocExampleCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative cursor-pointer",
        "rounded-xl border border-border/50",
        "bg-muted-foreground/5 hover:bg-accent/5",
        "transition-all duration-200",
        "hover:border-primary/20",
        "w-full max-w-[280px]"
      )}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          {icon && (
            <div className="flex-shrink-0 mt-0.5">
              {React.cloneElement(icon as React.ReactElement, { 
                className: "w-4 h-4 text-muted-foreground" 
              })}
            </div>
          )}
          <div className="flex-1 min-w-0 space-y-0.5">
            <h3 className="text-sm font-medium text-foreground truncate">
              {title}
            </h3>
            <p className="text-xs text-muted-foreground line-clamp-2">
              {subtitle}
            </p>
          </div>
        </div>
        <div className={cn(
          "relative rounded-lg border border-border/40",
          "bg-gradient-to-br from-muted/30 to-muted/10",
          "overflow-hidden h-20",
          "group-hover:border-border/60 transition-colors"
        )}>
          <div className="absolute inset-0">
            <DocumentTemplate type={templateType} />
          </div>
          <div className={cn(
            "absolute inset-0 bg-gradient-to-t from-background/80 to-transparent",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            "flex items-end justify-center pb-2"
          )}>
            <span className="text-[10px] font-medium text-primary">
              Generate →
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

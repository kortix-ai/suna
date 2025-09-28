'use client';

import React from 'react';

interface DocExampleCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
  icon?: React.ReactNode;
  templateType?: 'api' | 'readme' | 'guide' | 'schema' | 'changelog' | 'config';
  index?: number;
}

export function DocExampleCard({
  title,
  subtitle,
  onClick,
  icon,
  templateType = 'readme',
  index = 0
}: DocExampleCardProps) {
  const renderDocumentTemplate = () => {
    switch (templateType) {
      case 'api':
        return (
          <div className="h-full w-full bg-gradient-to-br from-blue-100 to-indigo-100 dark:from-blue-900/20 dark:to-indigo-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="w-12 h-1.5 bg-indigo-300/30 dark:bg-indigo-700/30 rounded-full" />
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 bg-blue-300 dark:bg-blue-700 rounded-full" />
                  <div className="w-14 h-1 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
                </div>
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 bg-blue-300 dark:bg-blue-700 rounded-full" />
                  <div className="w-10 h-1 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
                </div>
              </div>
              <div className="space-y-0.5 pt-1">
                <div className="w-full h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-5/6 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
              </div>
            </div>
          </div>
        );
      
      case 'readme':
        return (
          <div className="h-full w-full bg-gradient-to-br from-green-100 to-emerald-100 dark:from-green-900/20 dark:to-emerald-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="w-14 h-1.5 bg-emerald-300/30 dark:bg-emerald-700/30 rounded-full" />
              <div className="space-y-0.5">
                <div className="w-full h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-5/6 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-4/5 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
              </div>
              <div className="space-y-0.5 pt-1">
                <div className="w-full h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full animate-pulse" />
                <div className="w-3/4 h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full animate-pulse" />
              </div>
            </div>
          </div>
        );
      
      case 'guide':
        return (
          <div className="h-full w-full bg-gradient-to-br from-purple-100 to-violet-100 dark:from-purple-900/20 dark:to-violet-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="w-16 h-2 bg-violet-300/30 dark:bg-violet-700/30 rounded-full" />
              <div className="space-y-0.5 mt-1">
                <div className="w-full h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-full h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-5/6 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
              </div>
              <div className="w-10 h-1 bg-violet-300/20 dark:bg-violet-700/20 rounded-full animate-pulse" />
              <div className="space-y-0.5">
                <div className="w-4/5 h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full" />
                <div className="w-3/4 h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full" />
              </div>
            </div>
          </div>
        );
      
      case 'schema':
        return (
          <div className="h-full w-full bg-gradient-to-br from-yellow-100 to-amber-100 dark:from-yellow-900/20 dark:to-amber-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="flex items-center justify-between">
                <div className="w-14 h-1 bg-amber-300/30 dark:bg-amber-700/30 rounded-full" />
                <div className="w-8 h-1 bg-amber-300/20 dark:bg-amber-700/20 rounded-full" />
              </div>
              <div className="border border-amber-200/30 dark:border-amber-800/20 rounded p-1 space-y-0.5">
                <div className="w-12 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="space-y-0.5">
                  <div className="w-full h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full animate-pulse" />
                  <div className="w-5/6 h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full animate-pulse" />
                </div>
              </div>
            </div>
          </div>
        );
      
      case 'changelog':
        return (
          <div className="h-full w-full bg-gradient-to-br from-cyan-100 to-sky-100 dark:from-cyan-900/20 dark:to-sky-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="flex items-center gap-1">
                <div className="w-1 h-1 bg-sky-300 dark:bg-sky-700 rounded-full" />
                <div className="w-10 h-1 bg-sky-300/30 dark:bg-sky-700/30 rounded-full" />
              </div>
              <div className="pl-2 space-y-0.5">
                <div className="w-12 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
                <div className="w-14 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
              </div>
              <div className="flex items-center gap-1 pt-1">
                <div className="w-1 h-1 bg-sky-300 dark:bg-sky-700 rounded-full" />
                <div className="w-8 h-1 bg-sky-300/30 dark:bg-sky-700/30 rounded-full" />
              </div>
            </div>
          </div>
        );
      
      case 'config':
        return (
          <div className="h-full w-full bg-gradient-to-br from-rose-100 to-pink-100 dark:from-rose-900/20 dark:to-pink-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="space-y-0.5">
                <div className="w-12 h-1 bg-rose-300/30 dark:bg-rose-700/30 rounded-full" />
                <div className="pl-2 space-y-0.5">
                  <div className="w-14 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
                  <div className="w-10 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
                </div>
              </div>
              <div className="space-y-0.5 pt-1">
                <div className="w-10 h-1 bg-rose-300/30 dark:bg-rose-700/30 rounded-full" />
                <div className="pl-2">
                  <div className="w-11 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full animate-pulse" />
                </div>
              </div>
            </div>
          </div>
        );
      
      default:
        return (
          <div className="h-full w-full bg-gradient-to-br from-gray-100 to-slate-100 dark:from-gray-900/20 dark:to-slate-900/20 p-3">
            <div className="h-full w-full bg-white/50 dark:bg-gray-800/50 rounded-lg shadow-sm p-2 space-y-1">
              <div className="w-12 h-1.5 bg-gray-300/30 dark:bg-gray-700/30 rounded-full" />
              <div className="space-y-0.5">
                <div className="w-full h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-5/6 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
                <div className="w-4/5 h-0.5 bg-gray-200/50 dark:bg-gray-700/50 rounded-full" />
              </div>
              <div className="w-3/4 h-0.5 bg-gray-200/30 dark:bg-gray-700/30 rounded-full animate-pulse mt-1" />
            </div>
          </div>
        );
    }
  };

  return (
    <div
      onClick={onClick}
      className="group relative cursor-pointer rounded-xl border border-border/50 bg-muted-foreground/5 hover:bg-accent/5 transition-all duration-200 hover:border-primary/20 w-full max-w-[280px]"
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
        
        <div className="relative rounded-lg overflow-hidden h-20 border border-border/40">
          {renderDocumentTemplate()}
          
          <div className="absolute inset-0 bg-gradient-to-t from-background/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end justify-center pb-2">
            <span className="text-[10px] font-medium text-primary">
              Write →
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

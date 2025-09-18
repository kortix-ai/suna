'use client';

import React from 'react';
import { cn } from '@/lib/utils';

interface PresentationExampleCardProps {
  title: string;
  subtitle: string;
  onClick: () => void;
  icon?: React.ReactNode;
  slideType?: 'pitch' | 'sales' | 'data' | 'team' | 'product' | 'strategy';
  index?: number;
}

const SlideTemplate: React.FC<{ type: PresentationExampleCardProps['slideType'] }> = ({ type }) => {
  switch (type) {
    case 'pitch':
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-purple-500 to-pink-500 p-3 flex flex-col">
          <div className="flex items-center gap-1 mb-2">
            <div className="w-3 h-3 bg-white/30 rounded-full" />
            <div className="w-12 h-1.5 bg-white/40 rounded-full" />
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="w-16 h-16 bg-white/20 rounded-lg backdrop-blur-sm" />
          </div>
          <div className="space-y-1">
            <div className="w-20 h-1 bg-white/30 rounded-full" />
            <div className="w-16 h-1 bg-white/25 rounded-full" />
          </div>
        </div>
      );
    
    case 'sales':
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-blue-500 to-cyan-400 p-3 flex flex-col">
          <div className="w-16 h-1.5 bg-white/40 rounded-full mb-2" />
          <div className="flex gap-1 mb-2">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex-1 h-8 bg-white/20 rounded backdrop-blur-sm" />
            ))}
          </div>
          <div className="flex-1 space-y-1">
            <div className="w-full h-1 bg-white/25 rounded-full" />
            <div className="w-5/6 h-1 bg-white/25 rounded-full" />
          </div>
        </div>
      );
    
    case 'data':
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-emerald-500 to-teal-600 p-3">
          <div className="w-14 h-1.5 bg-white/40 rounded-full mb-2" />
          <div className="flex items-end gap-1 h-10 mb-2">
            <div className="w-3 bg-white/30 rounded-t" style={{ height: '60%' }} />
            <div className="w-3 bg-white/30 rounded-t" style={{ height: '80%' }} />
            <div className="w-3 bg-white/30 rounded-t" style={{ height: '40%' }} />
            <div className="w-3 bg-white/30 rounded-t" style={{ height: '90%' }} />
            <div className="w-3 bg-white/30 rounded-t" style={{ height: '70%' }} />
          </div>
          <div className="flex gap-1">
            <div className="w-8 h-1 bg-white/25 rounded-full" />
            <div className="w-8 h-1 bg-white/25 rounded-full" />
          </div>
        </div>
      );
    
    case 'team':
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-orange-400 to-amber-500 p-3">
          <div className="w-16 h-1.5 bg-white/40 rounded-full mb-3" />
          <div className="grid grid-cols-2 gap-1 mb-2">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="aspect-square bg-white/20 rounded-full" />
            ))}
          </div>
          <div className="space-y-0.5">
            <div className="w-full h-1 bg-white/25 rounded-full" />
            <div className="w-4/5 h-1 bg-white/25 rounded-full" />
          </div>
        </div>
      );
    
    case 'product':
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-violet-500 to-indigo-600 p-3 flex flex-col">
          <div className="w-20 h-2 bg-white/50 rounded-full mb-2" />
          <div className="flex-1 flex items-center justify-center mb-2">
            <div className="relative">
              <div className="w-14 h-14 bg-white/20 rounded-xl backdrop-blur-sm" />
              <div className="absolute -top-1 -right-1 w-4 h-4 bg-yellow-400/80 rounded-full flex items-center justify-center">
                <span className="text-[8px] font-bold text-violet-900">✨</span>
              </div>
            </div>
          </div>
          <div className="flex gap-1">
            <div className="flex-1 h-3 bg-white/20 rounded-full" />
            <div className="flex-1 h-3 bg-white/20 rounded-full" />
          </div>
        </div>
      );
    
    case 'strategy':
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-rose-500 to-pink-600 p-3">
          <div className="w-14 h-1.5 bg-white/40 rounded-full mb-2" />
          <div className="relative h-12 mb-2">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full h-0.5 bg-white/20" />
            </div>
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white/40 rounded-full" />
            <div className="absolute left-1/3 top-1/2 -translate-y-1/2 w-3 h-3 bg-white/40 rounded-full" />
            <div className="absolute left-2/3 top-1/2 -translate-y-1/2 w-3 h-3 bg-white/40 rounded-full" />
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white/60 rounded-full" />
          </div>
          <div className="space-y-0.5">
            <div className="w-20 h-1 bg-white/25 rounded-full" />
            <div className="w-16 h-1 bg-white/20 rounded-full" />
          </div>
        </div>
      );
    
    default:
      return (
        <div className="relative h-full w-full bg-gradient-to-br from-slate-500 to-gray-600 p-3">
          <div className="w-16 h-2 bg-white/40 rounded-full mb-2" />
          <div className="space-y-1 mb-2">
            <div className="w-full h-1 bg-white/25 rounded-full" />
            <div className="w-5/6 h-1 bg-white/25 rounded-full" />
            <div className="w-4/5 h-1 bg-white/25 rounded-full" />
          </div>
          <div className="flex gap-1">
            <div className="flex-1 h-4 bg-white/15 rounded" />
            <div className="flex-1 h-4 bg-white/15 rounded" />
          </div>
        </div>
      );
  }
};

export function PresentationExampleCard({
  title,
  subtitle,
  onClick,
  icon,
  slideType = 'pitch',
  index = 0
}: PresentationExampleCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group relative cursor-pointer",
        "rounded-xl overflow-hidden",
        "bg-muted-foreground/10 border border-border/50",
        "transition-all duration-200",
        "hover:border-primary/20",
        "w-full w-[220px]"
      )}
    >
      <div className="relative h-32 overflow-hidden">
        <SlideTemplate type={slideType} />
        <div className={cn(
          "absolute inset-0 bg-black/40 backdrop-blur-[2px]",
          "opacity-0 group-hover:opacity-100 transition-all duration-300",
          "flex items-center justify-center"
        )}>
          <div className="text-center">
            <div className="text-white text-sm font-medium mb-1">Create Presentation</div>
            <div className="text-white/80 text-xs">Click to generate →</div>
          </div>
        </div>
        <div className="absolute top-2 right-2 bg-white/90 backdrop-blur-sm rounded-full p-1.5 shadow-lg">
          {icon && React.cloneElement(icon as React.ReactElement, { 
            className: "w-3.5 h-3.5 text-gray-700" 
          })}
        </div>
      </div>
      <div className="p-4 space-y-1">
        <h3 className="text-sm font-semibold text-foreground line-clamp-1">
          {title}
        </h3>
        <p className="text-xs text-muted-foreground line-clamp-1">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

'use client';

import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';

export interface TabConfig {
  value: string;
  icon: LucideIcon;
  label: string;
  shortLabel?: string;
}

interface FancyTabsProps {
  tabs: TabConfig[];
  activeTab: string;
  onTabChange: (value: string) => void;
  className?: string;
}

interface TabButtonProps {
  value: string;
  isActive: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const TabButton = ({ value, isActive, onClick, children }: TabButtonProps) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-medium transition-all duration-300 ease-out",
        !isActive && (isDark ? "hover:bg-white/8" : "hover:bg-muted/60"),
        isActive 
          ? isDark ? "text-white" : "text-foreground bg-background border border-border/50"
          : isDark ? "text-white/60 hover:text-white/85" : "text-muted-foreground hover:text-foreground"
      )}
      style={isActive && isDark ? {
        background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.08))',
        backdropFilter: 'blur(12px)',
        boxShadow: `
          0 4px 8px rgba(0, 0, 0, 0.1),
          0 0 20px rgba(255, 255, 255, 0.1),
          0 0 40px rgba(255, 255, 255, 0.1),
          inset 0 1px 0 rgba(255, 255, 255, 0.2)
        `
      } : undefined}
    >
      {isActive && isDark && (
        <div 
          className="absolute inset-0 rounded-2xl opacity-40 blur-sm"
          style={{
            background: 'linear-gradient(45deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.1))',
            zIndex: -1
          }}
        />
      )}
      {children}
    </button>
  );
};

export const FancyTabs = ({ tabs, activeTab, onTabChange, className }: FancyTabsProps) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  
  return (
    <div 
      className={cn(
        "overflow-hidden grid w-full max-w-lg mx-auto rounded-3xl p-1.5",
        isDark ? "border-white/5" : "border-border/20 bg-muted",
        className
      )}
      style={{
        gridTemplateColumns: `repeat(${tabs.length}, 1fr)`,
        ...(isDark ? {
          background: 'rgba(255, 255, 255, 0.05)',
          backdropFilter: 'blur(20px)',
        } : {})
      }}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <TabButton 
            key={tab.value}
            value={tab.value} 
            isActive={activeTab === tab.value}
            onClick={() => onTabChange(tab.value)}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{tab.label}</span>
            {tab.shortLabel && (
              <span className="sm:hidden">{tab.shortLabel}</span>
            )}
          </TabButton>
        );
      })}
    </div>
  );
}; 
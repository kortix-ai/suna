'use client';

import { RobotIcon } from '@phosphor-icons/react';
import React from 'react';

import { cn } from '@/lib/utils';

interface AgentAvatarProps {
  agentName?: string;
  isDefault?: boolean;
  size?: number;
  className?: string;
}

export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  isDefault = false,
  size = 16,
  className = '',
}) => {
  const borderRadius = Math.min(size * 0.4, 16);
  const borderRadiusStyle = { borderRadius: `${borderRadius}px` };

  /* Filter out any rounded-* classes from className to prevent overrides */
  const filteredClassName = className
    .split(' ')
    .filter((cls) => !cls.match(/^rounded(-[a-z0-9]+)?$/))
    .join(' ');

  if (isDefault) {
    return (
      <div
        className={cn(
          'flex items-center justify-center border-transparent bg-zinc-900 dark:bg-zinc-100',
          filteredClassName,
        )}
        style={{ width: size, height: size, ...borderRadiusStyle }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/kortix-symbol.svg"
          alt="Kortix"
          className="shrink-0 invert dark:invert-0"
          style={{ width: `${size * 0.5}px`, height: `${size * 0.5}px` }}
        />
      </div>
    );
  }

  return (
    <div
      className={cn('bg-card flex items-center justify-center border', filteredClassName)}
      style={{ width: size, height: size, ...borderRadiusStyle }}
    >
      <RobotIcon size={size * 0.5} color="#6B7280" />
    </div>
  );
};

interface AgentNameProps {
  fallback?: string;
  name?: string;
}

export const AgentName: React.FC<AgentNameProps> = ({ name, fallback = 'Kortix' }) => {
  return <span>{name || fallback}</span>;
};

export function hasCustomProfile(agent: { icon_name?: string | null }): boolean {
  return !!agent.icon_name;
}

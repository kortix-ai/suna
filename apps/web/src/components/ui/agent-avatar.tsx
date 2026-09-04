'use client';

import { RobotIcon } from '@phosphor-icons/react';
import React from 'react';

import { useBranding } from '@/features/branding/branding-provider';
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
  // The default agent wears the platform mark — which is the org's own symbol
  // when the account is branded (Enterprise `branding`), else the Kortix one.
  const branding = useBranding();
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
          // The tile is zinc-900 in light mode and zinc-100 in dark mode, so
          // the mark that reads on it is the OPPOSITE scheme's variant.
          src={
            branding?.icon_url
              ? (branding.icon_dark_url ?? branding.icon_url)
              : '/kortix-symbol.svg'
          }
          alt={branding?.app_name ?? 'Kortix'}
          className={cn(
            'shrink-0 object-contain',
            // The Kortix symbol is black-on-transparent and inverts onto the
            // dark tile; an uploaded mark keeps its own colors.
            !branding?.icon_url && 'invert dark:invert-0',
            branding?.icon_dark_url && 'dark:hidden',
          )}
          style={{ width: `${size * 0.5}px`, height: `${size * 0.5}px` }}
        />
        {branding?.icon_url && branding.icon_dark_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={branding.icon_url}
            alt=""
            aria-hidden
            className="hidden shrink-0 object-contain dark:block"
            style={{ width: `${size * 0.5}px`, height: `${size * 0.5}px` }}
          />
        ) : null}
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

'use client';

import React from 'react';
import { DynamicIcon } from 'lucide-react/dynamic';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { cn } from '@/lib/utils';

interface AgentIconAvatarProps {
  profileImageUrl?: string | null;
  iconName?: string | null;
  iconColor?: string;
  backgroundColor?: string;
  agentName?: string;
  size?: number;
  className?: string;
  isSunaDefault?: boolean;
}

export function AgentIconAvatar({
  profileImageUrl,
  iconName,
  iconColor = '#000000',
  backgroundColor = '#F3F4F6',
  agentName = 'Agent',
  size = 40,
  className,
  isSunaDefault = false
}: AgentIconAvatarProps) {
  if (isSunaDefault) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center rounded-lg bg-muted border",
          className
        )}
        style={{ width: size, height: size }}
      >
        <KortixLogo size={size * 0.6} />
      </div>
    );
  }
  
  if (iconName) {
    return (
      <div 
        className={cn(
          "flex items-center justify-center rounded-lg transition-all",
          className
        )}
        style={{ 
          width: size, 
          height: size,
          backgroundColor
        }}
      >
        <DynamicIcon 
          name={iconName as any} 
          size={size * 0.5} 
          color={iconColor}
        />
      </div>
    );
  }
  
  if (profileImageUrl) {
    return (
      <Avatar 
        className={cn("rounded-lg", className)}
        style={{ width: size, height: size }}
      >
        <AvatarImage 
          src={profileImageUrl} 
          alt={agentName}
          className="object-cover"
        />
        <AvatarFallback className="rounded-lg">
          <div className="w-full h-full flex items-center justify-center bg-muted">
            <DynamicIcon 
              name="bot" 
              size={size * 0.5} 
              color="#6B7280"
            />
          </div>
        </AvatarFallback>
      </Avatar>
    );
  }
  
  return (
    <div 
      className={cn(
        "flex items-center justify-center rounded-lg bg-muted",
        className
      )}
      style={{ width: size, height: size }}
    >
      <DynamicIcon 
        name="bot" 
        size={size * 0.5} 
        color="#6B7280"
      />
    </div>
  );
}

export function hasCustomProfile(agent: {
  profile_image_url?: string | null;
  icon_name?: string | null;
}): boolean {
  return !!(agent.icon_name || agent.profile_image_url);
} 
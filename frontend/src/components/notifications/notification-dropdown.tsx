'use client';

import React, { useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { isStagingMode } from '@/lib/config';
import { Inbox } from '@novu/nextjs';
import { Circle, Check } from 'lucide-react';
import { Button } from '../ui/button';
import { useTheme } from 'next-themes';
import { Badge } from '../ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar';
import { Markdown } from '../ui/markdown';

type ChannelType = 'in_app' | 'email' | 'sms' | 'push' | 'chat';

type Subscriber = {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  avatar?: string;
};

type Redirect = {
  url: string;
  target?: '_blank' | '_self';
};

type Action = {
  label: string;
  url?: string;
  isCompleted?: boolean;
};

type Workflow = {
  id: string;
  identifier: string;
  name: string;
};

type Notification = {
  id: string;
  body: string;
  redirect?: Redirect;
  primaryAction?: Action;
  secondaryAction?: Action;
  channelType: ChannelType;
  data?: Record<string, unknown>;
  to: Subscriber;
  subject?: string;
  isRead: boolean;
  isSeen: boolean;
  isArchived: boolean;
  isSnoozed: boolean;
  readAt?: string | null;
  archivedAt?: string | null;
  avatar?: string;
  tags?: string[];
  workflow: Workflow;
  deliveredAt: string | null;
  firstSeenAt: string | null;
  updatedAt: string;
  createdAt: string;
};

const getRelativeTime = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

const NotificationItem = (notification: Notification) => {
  const handleNavigation = (url: string, target?: '_blank' | '_self' | '_parent' | '_top') => {
    if (url.startsWith('/internal/dialog/')) {
      const dialogType = url.replace('/internal/dialog/', '');
      console.log('Open dialog:', dialogType, notification.data);
      return;
    }

    if (url.startsWith('/internal/action/')) {
      const actionType = url.replace('/internal/action/', '');
      console.log('Trigger action:', actionType, notification.data);
      return;
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      window.open(url, target || '_blank');
      return;
    }

    window.location.href = url;
  };

  const handleClick = () => {
    if (notification.redirect?.url) {
      handleNavigation(notification.redirect.url, notification.redirect.target);
    }
  };

  const handlePrimaryAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (notification.primaryAction?.url) {
      handleNavigation(notification.primaryAction.url, '_blank');
    }
  };

  const handleSecondaryAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (notification.secondaryAction?.url) {
      handleNavigation(notification.secondaryAction.url, '_blank');
    }
  };

  return (
     <div onClick={handleClick} className='p-2 flex items-center justify-center'>
         <div
         className={`
             relative px-4 py-3 rounded-xl transition-all cursor-pointer group
             ${notification.isRead ? 'bg-card' : 'bg-muted/30'}
             hover:bg-accent/50
         `}
         style={{
             border: '1px solid transparent',
         }}
         onMouseEnter={(e) => {
             e.currentTarget.style.borderColor = 'var(--border)';
         }}
         onMouseLeave={(e) => {
             e.currentTarget.style.borderColor = 'transparent';
         }}
         >
        <div className="flex gap-3">
            {notification.avatar && (
                <Avatar className="h-10 w-10 flex-shrink-0">
                    <AvatarImage src={notification.avatar} />
                    <AvatarFallback className="bg-primary/10 text-primary text-sm">
                        {notification.subject?.charAt(0) || 'N'}
                    </AvatarFallback>
                </Avatar>
            )}
            
            <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                {notification.subject && (
                    <h4 
                      className={`text-sm font-medium leading-tight`}
                      style={{
                        fontWeight: '600',
                      }}
                    >
                        {notification.subject}
                    </h4>
                )}
                <Markdown
                    className={`text-xs text-muted-foreground line-clamp-2 ${notification.isRead ? 'text-muted-foreground font-normal' : 'text-foreground font-medium'}`}
                >
                    {notification.body}
                </Markdown>
                </div>
                
                {!notification.isRead && (
                <Circle className="h-2 w-2 fill-primary text-primary flex-shrink-0 mt-1.5" />
                )}
            </div>

            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">
                {getRelativeTime(notification.createdAt)}
                </span>
                
                {notification.tags && notification.tags.length > 0 && (
                <>
                    <span className="text-muted-foreground">•</span>
                    <div className="flex gap-1 flex-wrap">
                    {notification.tags.slice(0, 2).map((tag, index) => (
                        <Badge
                        key={index}
                        variant="secondary"
                        className="text-xs px-1.5 py-0 h-5"
                        >
                        {tag}
                        </Badge>
                    ))}
                    {notification.tags.length > 2 && (
                        <Badge
                        variant="secondary"
                        className="text-xs px-1.5 py-0 h-5"
                        >
                        +{notification.tags.length - 2}
                        </Badge>
                    )}
                    </div>
                </>
                )}
            </div>

            {(notification.primaryAction || notification.secondaryAction) && (
                <div className="flex gap-2 pt-1">
                {notification.primaryAction && (
                    <Button
                        size="sm"
                        variant="default"
                        className="h-7 text-xs"
                        onClick={handlePrimaryAction}
                    >
                    {notification.primaryAction.isCompleted && (
                        <Check className="h-3 w-3 mr-1" />
                    )}
                    {notification.primaryAction.label}
                    </Button>
                )}
                {notification.secondaryAction && (
                    <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleSecondaryAction}
                    >
                    {notification.secondaryAction.label}
                    </Button>
                )}
                </div>
            )}
            </div>
        </div>
        </div>
    </div>
  );
}

export function NotificationDropdown() {
  const { user } = useAuth();
  const applicationIdentifier = process.env.NEXT_PUBLIC_NOVU_APP_IDENTIFIER;
  const [unreadCount, setUnreadCount] = useState(0);
  const { theme } = useTheme();

  const appearance = {
    variables: {
      colorBackground: 'var(--card)',
      borderRadius: '8px',
      colorForeground: 'var(--foreground)',
      colorPrimary: 'var(--primary)',
      colorSecondary: 'var(--secondary)',
      colorDestructive: 'var(--destructive)',
      colorMuted: 'var(--muted)',
      colorAccent: 'var(--accent)',
      colorPopover: 'var(--popover)',
    },
  };

  if (!isStagingMode() || !user?.id || !applicationIdentifier) {
    return null;
  }

  return (
    <div className='z-12'>
      <Inbox
        applicationIdentifier={applicationIdentifier}
        subscriberId={user.id}
        appearance={appearance}
        renderNotification={NotificationItem as any}
      />
    </div>
  );
}

export { NotificationItem };

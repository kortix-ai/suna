import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ComposioToolkit } from '@/hooks/react-query/composio/utils';

interface ComposioAppCardProps {
  app: ComposioToolkit;
  mode?: 'full' | 'profile-only';
  onConnectApp?: (app: ComposioToolkit) => void;
  isConnected?: boolean;
  onConfigureTools?: () => void;
}

export const ComposioAppCard: React.FC<ComposioAppCardProps> = ({
  app,
  mode = 'full',
  onConnectApp,
  isConnected = false,
  onConfigureTools,
}) => {
  const [imageError, setImageError] = useState(false);

  const handleConnect = () => {
    onConnectApp?.(app);
  };

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border bg-card transition-all hover:shadow-md hover:shadow-primary/5">
      <div className="p-6">
        <div className="flex items-center gap-4 mb-4">
          <div className="relative h-12 w-12 rounded-xl overflow-hidden bg-muted flex-shrink-0">
            {app.logo && !imageError ? (
              <img
                src={app.logo}
                alt={`${app.name} logo`}
                className="h-full w-full object-cover"
                onError={() => setImageError(true)}
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center bg-gradient-to-br from-primary/10 to-primary/5 text-primary font-semibold text-lg">
                {app.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-foreground text-lg mb-1 truncate">
              {app.name}
            </h3>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="truncate">by Composio</span>
              {isConnected && (
                <Badge variant="secondary" className="bg-green-50 text-green-700 border-green-200 dark:border-green-900 dark:bg-green-900/20 dark:text-green-400">
                  Connected
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3 mb-4">
          <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
            {app.description || `Connect to ${app.name} and access its tools and capabilities.`}
          </p>
          
          {app.tags && app.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {app.tags.slice(0, 3).map((tag, index) => (
                <Badge
                  key={index}
                  variant="outline"
                  className="text-xs px-2 py-0.5 bg-muted/50 hover:bg-muted border-muted-foreground/20"
                >
                  {tag}
                </Badge>
              ))}
              {app.tags.length > 3 && (
                <Badge
                  variant="outline"
                  className="text-xs px-2 py-0.5 bg-muted/50 border-muted-foreground/20"
                >
                  +{app.tags.length - 3} more
                </Badge>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between">
          {isConnected ? (
            <Button
              onClick={onConfigureTools}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              size="sm"
            >
              Configure Tools
            </Button>
          ) : (
            <Button
              onClick={handleConnect}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              size="sm"
            >
              Connect
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}; 
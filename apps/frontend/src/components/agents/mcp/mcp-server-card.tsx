import React from 'react';
import { Card } from '@/components/ui/card';
import { Shield, ExternalLink, ChevronRight, Sparkles } from 'lucide-react';
import { truncateString } from '@/lib/utils';

interface McpServerCardProps {
  server: any;
  onClick: (server: any) => void;
}

export const McpServerCard: React.FC<McpServerCardProps> = ({ server, onClick }) => {
  return (
    <Card
      className="p-4 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={() => onClick(server)}
    >
      <div className="flex items-start gap-3 flex-shrink-0">
        {server.iconUrl ? (
          <img src={server.iconUrl} alt={server.displayName || server.name} className="w-6 h-6 rounded" />
        ) : (
          <div className="w-6 h-6 rounded bg-primary/10 flex items-center justify-center">
            <Sparkles className="h-3 w-3 text-primary" />
          </div>
        )}
        <div className="flex-1 w-auto">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm">{server.displayName || server.name}</h4>
            {server.security?.scanPassed && (
              <Shield className="h-3 w-3 text-green-500" />
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-normal">
            {truncateString(server.description, 100)}
          </p>
          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
            <span>Used {server.useCount} times</span>
            {server.homepage && (
              <ExternalLink className="h-3 w-3" />
            )}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
      </div>
    </Card>
  );
};

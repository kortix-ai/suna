'use client';

import { usePresenceContext } from '@/providers/presence-provider';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { backendApi } from '@/lib/api-client';
import { useState } from 'react';

export function PresenceDebug() {
  const { connectionState, presences, activeThreadId, sessionId } = usePresenceContext();
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  
  console.log('[PresenceDebug] Presences:', presences, 'Keys:', Object.keys(presences));
  
  const clearSessionStorage = () => {
    if (typeof window !== 'undefined') {
      sessionStorage.removeItem('presence_session_id');
      window.location.reload();
    }
  };
  
  const cleanupStaleSessions = async () => {
    setIsCleaningUp(true);
    try {
      const response = await backendApi.post('/presence/cleanup', {}, { showErrors: false });
      if (response.data?.cleaned > 0) {
        console.log(`Cleaned up ${response.data.cleaned} stale sessions`);
      }
    } catch (err) {
      console.error('Failed to cleanup sessions:', err);
    } finally {
      setIsCleaningUp(false);
    }
  };

  const statusColors = {
    idle: 'bg-gray-500',
    connecting: 'bg-yellow-500',
    connected: 'bg-green-500',
    error: 'bg-red-500',
  };

  const uniqueAccounts = new Set(
    Object.values(presences).map(p => p.account_id)
  ).size;

  return (
    <Card className="fixed bottom-4 right-4 p-4 max-w-sm z-50 max-h-[80vh] overflow-auto">
      <div className="space-y-3">
        <div className="flex items-center gap-2 justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm">Presence Debug</h3>
            <Badge 
              variant="outline" 
              className={`${statusColors[connectionState]} text-white border-none`}
            >
              {connectionState}
            </Badge>
          </div>
          <div className="flex gap-1">
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={cleanupStaleSessions}
              disabled={isCleaningUp}
              className="h-6 px-2 text-xs"
              title="Clean up stale sessions older than 5 minutes"
            >
              {isCleaningUp ? '...' : 'Cleanup'}
            </Button>
            <Button 
              size="sm" 
              variant="ghost" 
              onClick={clearSessionStorage}
              className="h-6 px-2 text-xs"
              title="Clear session storage"
            >
              Reset
            </Button>
          </div>
        </div>
        
        <div className="text-xs space-y-1">
          <div>
            <span className="text-muted-foreground">Session ID:</span>{' '}
            <span className="font-mono text-[10px]">{sessionId?.slice(0, 8) || 'none'}</span>
          </div>
          
          <div>
            <span className="text-muted-foreground">Active Thread:</span>{' '}
            <span className="font-mono text-[10px]">{activeThreadId?.slice(0, 8) || 'none'}</span>
          </div>
          
          <div>
            <span className="text-muted-foreground">Active Sessions:</span>{' '}
            <span className="font-semibold">{Object.keys(presences).length}</span>
          </div>
          
          <div>
            <span className="text-muted-foreground">Unique Accounts:</span>{' '}
            <span className="font-semibold">{uniqueAccounts}</span>
          </div>
          
          {Object.entries(presences).map(([key, presence]) => (
            <div key={key} className="border-t pt-2 mt-2">
              <div className="font-mono text-[10px] truncate">
                Account: {presence.account_id.slice(0, 8)}
              </div>
              {presence.session_id && (
                <div className="font-mono text-[10px] truncate text-muted-foreground">
                  Session: {presence.session_id.slice(0, 8)}
                </div>
              )}
              <div className="text-muted-foreground">
                Thread: {presence.active_thread_id?.slice(0, 8) || 'none'}
              </div>
              <div className="text-muted-foreground">
                Status: {presence.status} • {presence.platform}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}


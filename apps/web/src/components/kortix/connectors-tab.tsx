'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Plug, RefreshCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast';
import {
  deleteProjectConnector,
  listProjectConnectors,
  startProjectConnectorOAuth,
  syncProjectConnectors,
  updateProjectConnector,
  type IntegrationStatus,
  type ProjectConnector,
} from '@/lib/projects-client';

export function ConnectorsTab({ projectId }: { projectId: string }) {
  const [connectors, setConnectors] = useState<ProjectConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [app, setApp] = useState('slack');
  const [scopes, setScopes] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setConnectors(await listProjectConnectors(projectId));
    } catch (error) {
      toast.error('Failed to load connectors', { description: error instanceof Error ? error.message : String(error) });
      setConnectors([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeCount = useMemo(() => connectors.filter((connector) => connector.status === 'active').length, [connectors]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncProjectConnectors(projectId, app.trim() ? { app: app.trim() } : {});
      toast.success(`Synced ${result.synced} connector${result.synced === 1 ? '' : 's'}`);
      await load();
    } catch (error) {
      toast.error('Failed to sync connectors', { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSyncing(false);
    }
  };

  const handleOAuth = async () => {
    const appSlug = app.trim();
    if (!appSlug) {
      toast.error('App slug is required');
      return;
    }

    setStarting(true);
    try {
      const parsedScopes = scopes.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
      const result = await startProjectConnectorOAuth(projectId, {
        app: appSlug,
        scopes: parsedScopes.length > 0 ? parsedScopes : undefined,
      });
      window.location.href = result.authorization_url;
    } catch (error) {
      toast.error('OAuth is not configured for this connector', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  const handleStatus = async (connector: ProjectConnector, status: IntegrationStatus) => {
    setConnectors((current) => current.map((item) => item.connector_id === connector.connector_id ? { ...item, status } : item));
    try {
      await updateProjectConnector(projectId, connector.connector_id, { status });
      toast.success(status === 'active' ? 'Connector enabled' : 'Connector revoked');
    } catch (error) {
      setConnectors((current) => current.map((item) => item.connector_id === connector.connector_id ? connector : item));
      toast.error('Failed to update connector', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const handleDelete = async (connector: ProjectConnector) => {
    setConnectors((current) => current.filter((item) => item.connector_id !== connector.connector_id));
    try {
      await deleteProjectConnector(projectId, connector.connector_id);
      toast.success('Connector removed');
    } catch (error) {
      toast.error('Failed to remove connector', { description: error instanceof Error ? error.message : String(error) });
      await load();
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Plug className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Connectors</span>
          <Badge variant="secondary" className="text-[10px] tabular-nums">{activeCount}/{connectors.length}</Badge>
        </div>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-[12px]" onClick={() => void load()} disabled={loading}>
          <RefreshCcw className="h-3 w-3" />
          Refresh
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        <div className="rounded-lg border border-border/50 bg-card p-3 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Connect app</h3>
            <p className="text-[12px] text-muted-foreground">Project connectors stay cloud-side; sessions receive only a scoped connector token.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-2">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">App slug</span>
              <Input value={app} onChange={(event) => setApp(event.target.value)} placeholder="slack, notion, linear" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-muted-foreground">OAuth scopes</span>
              <Input value={scopes} onChange={(event) => setScopes(event.target.value)} placeholder="chat:write channels:history" />
            </label>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-[12px]" onClick={() => void handleSync()} disabled={syncing}>
              <RefreshCcw className="h-3 w-3" />
              {syncing ? 'Syncing' : 'Sync provider'}
            </Button>
            <Button size="sm" className="h-8 gap-1.5 text-[12px]" onClick={() => void handleOAuth()} disabled={starting}>
              <ExternalLink className="h-3 w-3" />
              {starting ? 'Opening' : 'Start OAuth'}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((index) => (
              <div key={index} className="rounded-lg border border-border/50 bg-card p-3">
                <Skeleton className="h-4 w-40 mb-2" />
                <Skeleton className="h-3 w-64" />
              </div>
            ))}
          </div>
        ) : connectors.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 p-6 text-center">
            <p className="text-sm font-medium">No project connectors</p>
            <p className="text-[12px] text-muted-foreground mt-1">Connect or sync an app to expose cloud-routed tools to this project.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {connectors.map((connector) => (
              <ConnectorRow
                key={connector.connector_id}
                connector={connector}
                onStatus={handleStatus}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectorRow({
  connector,
  onStatus,
  onDelete,
}: {
  connector: ProjectConnector;
  onStatus: (connector: ProjectConnector, status: IntegrationStatus) => void;
  onDelete: (connector: ProjectConnector) => void;
}) {
  const isActive = connector.status === 'active';
  return (
    <div className="rounded-lg border border-border/50 bg-card p-3 flex items-start gap-3">
      <div className="h-9 w-9 rounded-md border border-border/50 bg-muted flex items-center justify-center shrink-0">
        <Plug className="h-4 w-4 text-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold truncate">{connector.label || connector.app_name || connector.app}</p>
          <Badge variant={isActive ? 'highlight' : 'secondary'} className="text-[10px]">{connector.status}</Badge>
          {connector.metadata?.direct_oauth ? <Badge variant="secondary" className="text-[10px]">Direct OAuth</Badge> : null}
        </div>
        <p className="text-[12px] text-muted-foreground truncate">
          {connector.provider} / {connector.app}{connector.provider_account_id ? ` / ${connector.provider_account_id}` : ''}
        </p>
        {connector.scopes.length > 0 ? (
          <p className="mt-1 text-[11px] text-muted-foreground truncate">{connector.scopes.join(' ')}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => onStatus(connector, isActive ? 'revoked' : 'active')}
        >
          <ShieldCheck className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive" onClick={() => onDelete(connector)}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

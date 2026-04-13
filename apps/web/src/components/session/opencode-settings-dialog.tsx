'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Settings,
  Shield,
  Zap,
  Loader2,
  Unplug,
  Save,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Server,
  Plus,
  AlertCircle,
  Plug,
  Power,
  Wrench,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  useOpenCodeConfig,
  useUpdateOpenCodeConfig,
} from '@/hooks/opencode/use-opencode-config';
import type { Config } from '@/hooks/opencode/use-opencode-config';
import {
  useOpenCodeProviders,
  useOpenCodeToolIds,
} from '@/hooks/opencode/use-opencode-sessions';
import { getClient } from '@/lib/opencode-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { opencodeKeys } from '@/hooks/opencode/use-opencode-sessions';
import { ProviderList } from '@/components/providers/provider-list';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import { ModelSelector } from '@/components/session/model-selector';
import { flattenModels } from '@/components/session/session-chat-input';
import {
  useOpenCodeMcpStatus,
  useAddMcpServer,
  useConnectMcpServer,
  useDisconnectMcpServer,
  useMcpAuthStart,
  useMcpAuthCallback,
} from '@/hooks/opencode/use-opencode-mcp';
import type { McpStatus } from '@/hooks/opencode/use-opencode-mcp';
import { toast } from '@/lib/toast';
import { setGlobalDefaultModel } from '@/hooks/opencode/use-model-store';

// ============================================================================
// Constants
// ============================================================================

const PERMISSION_TYPES = [
  { key: 'read', label: 'Read', description: 'Read files in the project' },
  { key: 'edit', label: 'Edit', description: 'Edit files in the project' },
  { key: 'bash', label: 'Bash', description: 'Run shell commands' },
  { key: 'glob', label: 'Glob', description: 'Search files by pattern' },
  { key: 'grep', label: 'Grep', description: 'Search file contents' },
  { key: 'list', label: 'List', description: 'List directory contents' },
  { key: 'webfetch', label: 'Web Fetch', description: 'Fetch content from the web' },
  { key: 'task', label: 'Task', description: 'Run sub-agent tasks' },
  { key: 'external_directory', label: 'External Dir', description: 'Access outside project' },
  { key: 'doom_loop', label: 'Doom Loop', description: 'Re-prompt on failure loops' },
] as const;

const ACTIONS = ['allow', 'ask', 'deny'] as const;

// ============================================================================
// Props
// ============================================================================

export type OpenCodeSettingsTab = 'general' | 'providers' | 'permissions' | 'mcp';

interface OpenCodeSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: OpenCodeSettingsTab;
}

// ============================================================================
// General Tab
// ============================================================================

function GeneralSection({
  draft,
  config,
  onDraft,
}: {
  draft: Record<string, unknown>;
  config: Config;
  onDraft: (key: string, value: unknown) => void;
}) {
  const { data: providers } = useOpenCodeProviders();
  const allModels = useMemo(() => flattenModels(providers), [providers]);

  const modelStr = (draft.model as string) ?? config.model ?? '';
  const selectedModel = useMemo(() => {
    if (!modelStr) return null;
    const idx = modelStr.indexOf('/');
    if (idx <= 0) return null;
    return { providerID: modelStr.slice(0, idx), modelID: modelStr.slice(idx + 1) };
  }, [modelStr]);

  const handleModelSelect = useCallback(
    (model: { providerID: string; modelID: string } | null) => {
      onDraft('model', model ? `${model.providerID}/${model.modelID}` : undefined);
    },
    [onDraft],
  );

  const instructions = (draft.instructions as string[]) ?? config.instructions ?? [];
  const instructionsText = instructions.join('\n');
  const snapshot = (draft.snapshot as boolean | undefined) ?? config.snapshot ?? false;

  return (
    <div className="space-y-6">
      {/* Custom Instructions */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Custom Instructions
        </label>
        <p className="text-xs text-muted-foreground/60">
          Additional instruction file paths, one per line (e.g. docs/rules.md)
        </p>
        <Textarea
          value={instructionsText}
          onChange={(e) => {
            const lines = e.target.value
              .split('\n')
              .filter((l) => l.trim() !== '');
            onDraft('instructions', lines.length > 0 ? lines : undefined);
          }}
          placeholder="docs/rules.md&#10;.cursorrules&#10;AGENTS.md"
          rows={4}
          className="font-mono text-sm resize-none rounded-xl"
        />
      </div>

      {/* Default Model */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Default Model
        </label>
        <div className="flex items-center gap-2">
          <ModelSelector
            models={allModels}
            selectedModel={selectedModel}
            onSelect={handleModelSelect}
          />
          {selectedModel && (
            <Button
              type="button"
              onClick={() => onDraft('model', undefined)}
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-muted-foreground"
            >
              Reset to auto
            </Button>
          )}
          {!selectedModel && (
            <span className="text-xs text-muted-foreground/60">Auto-detect</span>
          )}
        </div>
      </div>

      {/* Snapshots */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Snapshots
            </label>
            <p className="text-xs text-muted-foreground/60 mt-0.5">
              Create a git snapshot at each agentic step for reviewing changes
            </p>
          </div>
          <Switch
            checked={snapshot}
            onCheckedChange={(v) => onDraft('snapshot', v)}
          />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Providers Tab
// ============================================================================

function ProvidersSection({
  onDirty,
}: {
  onDirty: () => void;
}) {
  const { data: providers } = useOpenCodeProviders();
  const openProviderModal = useProviderModalStore((s) => s.openProviderModal);

  const connectedProviders = useMemo(() => {
    if (!providers) return [];
    const connectedIds = new Set(providers.connected ?? []);
    return (providers.all ?? []).filter((p) => connectedIds.has(p.id));
  }, [providers]);

  return (
    <div className="space-y-3 overflow-y-auto">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider">
          Connected ({connectedProviders.length})
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs gap-1.5 "
          onClick={() => openProviderModal('providers')}
        >
          <Plus className="h-3 w-3" />
          Connect
        </Button>
      </div>

      <ProviderList
        connectedProviders={connectedProviders}
        onConnect={() => openProviderModal('providers')}
        onDisconnected={onDirty}
        showConnectButton={connectedProviders.length === 0}
      />
    </div>
  );
}

// ============================================================================
// Permissions Tab
// ============================================================================

function PermissionsSection({
  draft,
  config,
  onDraft,
}: {
  draft: Record<string, unknown>;
  config: Config;
  onDraft: (key: string, value: unknown) => void;
}) {
  const { data: toolIds } = useOpenCodeToolIds();

  const permission = (draft.permission ?? config.permission ?? {}) as Record<
    string,
    any
  >;
  const isGlobalMode = typeof permission === 'string';
  const globalAction = isGlobalMode ? (permission as string) : 'ask';
  // Resolve the wildcard fallback: permission["*"] acts as the default for all tools
  const wildcardAction = !isGlobalMode && typeof (permission as Record<string, any>)['*'] === 'string'
    ? (permission as Record<string, any>)['*']
    : 'ask';

  const getAction = (key: string): string => {
    if (isGlobalMode) return globalAction;
    const val = (permission as Record<string, any>)[key];
    if (typeof val === 'string') return val;
    return wildcardAction;
  };

  const setAction = (key: string, action: string) => {
    const base = isGlobalMode ? {} : { ...(permission as Record<string, any>) };
    onDraft('permission', { ...base, [key]: action });
  };

  const setGlobalMode = (action: string) => {
    onDraft('permission', action);
  };

  // Per-tool overrides from config.tools
  const tools = (draft.tools ?? config.tools ?? {}) as Record<string, boolean>;

  const builtinToolIds = useMemo(() => {
    if (!toolIds) return [];
    return toolIds.filter((id) => !id.includes('_mcp_') && !id.startsWith('mcp_')).sort();
  }, [toolIds]);

  const isToolEnabled = (id: string) => tools[id] !== false;

  const toggleTool = (id: string) => {
    const next = { ...tools };
    if (isToolEnabled(id)) {
      next[id] = false;
    } else {
      delete next[id];
    }
    const hasOverrides = Object.values(next).some((v) => v === false);
    onDraft('tools', hasOverrides ? next : undefined);
  };

  return (
    <div className="space-y-6">
      {/* Global permission mode */}
      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Global Permission Mode
        </label>
        <p className="text-xs text-muted-foreground/60">
          Set a blanket permission level, or configure per-tool below.
        </p>
        <div className="flex gap-1.5">
          {ACTIONS.map((a) => (
            <Button
              key={a}
              onClick={() => setGlobalMode(a)}
              size="toolbar"
              variant={isGlobalMode && globalAction === a
                ? a === 'allow' ? 'success'
                : a === 'deny' ? 'destructive'
                : 'muted'
                : 'muted'}
              className={cn(
                isGlobalMode && globalAction === a && a === 'allow' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20',
                isGlobalMode && globalAction === a && a === 'deny' && 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20',
                isGlobalMode && globalAction === a && a === 'ask' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20',
              )}
            >
              {a}
            </Button>
          ))}
          <Button
            onClick={() => { if (isGlobalMode) { onDraft('permission', {}); } }}
            size="toolbar"
            variant="muted"
            className={cn(
              !isGlobalMode && 'bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/20 hover:bg-blue-500/20',
            )}
          >
            per-tool
          </Button>
        </div>
      </div>

      {/* Per-tool permission overrides */}
      {!isGlobalMode && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Per-Tool Permissions
          </label>
          <div className="rounded-xl border border-border/50 bg-card divide-y divide-border/30">
            {PERMISSION_TYPES.map(({ key, label, description }) => (
              <div
                key={key}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <span className="text-sm text-foreground">{label}</span>
                  <p className="text-xs text-muted-foreground/60">{description}</p>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {ACTIONS.map((a) => (
                    <Button
                      key={a}
                      onClick={() => setAction(key, a)}
                      size="xs"
                      variant="muted"
                      className={cn(
                        getAction(key) === a && a === 'allow' && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20',
                        getAction(key) === a && a === 'deny' && 'bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20',
                        getAction(key) === a && a === 'ask' && 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 hover:bg-amber-500/20',
                      )}
                    >
                      {a}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool enable/disable overrides */}
      {builtinToolIds.length > 0 && (
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Tool Overrides
          </label>
          <p className="text-xs text-muted-foreground/60">
            Enable or disable individual tools.
          </p>
          <div className="rounded-xl border border-border/50 bg-card divide-y divide-border/30 max-h-48 overflow-y-auto">
            {builtinToolIds.map((id) => (
              <div
                key={id}
                className="flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
              >
                <span className="text-xs font-mono text-foreground/80 truncate">
                  {id}
                </span>
                <Switch
                  checked={isToolEnabled(id)}
                  onCheckedChange={() => toggleTool(id)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// MCP Servers Tab
// ============================================================================

type McpView = { type: 'list' } | { type: 'add' } | { type: 'auth'; name: string };

function StatusBadge({ status }: { status: McpStatus }) {
  const s = status.status;
  if (s === 'connected') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        connected
      </span>
    );
  }
  if (s === 'disabled') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
        disconnected
      </span>
    );
  }
  if (s === 'needs_auth' || s === 'needs_client_registration') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        needs auth
      </span>
    );
  }
  // failed
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-red-500/10 text-red-600 dark:text-red-400">
      <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
      error
    </span>
  );
}

function McpServersSection() {
  const { data: mcpStatus, isLoading } = useOpenCodeMcpStatus();
  const { data: toolIds } = useOpenCodeToolIds();
  const addMutation = useAddMcpServer();
  const connectMutation = useConnectMcpServer();
  const disconnectMutation = useDisconnectMcpServer();
  const authStartMutation = useMcpAuthStart();
  const authCallbackMutation = useMcpAuthCallback();

  const [view, setView] = useState<McpView>({ type: 'list' });
  const [expanded, setExpanded] = useState<string | null>(null);

  // Add form state
  const [addForm, setAddForm] = useState({
    name: '',
    transportType: 'stdio' as 'stdio' | 'http',
    command: '',
    url: '',
    envPairs: [] as Array<{ key: string; value: string }>,
  });
  const [addError, setAddError] = useState('');

  // Auth state
  const [authUrl, setAuthUrl] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [authError, setAuthError] = useState('');

  const servers = useMemo(() => {
    if (!mcpStatus) return [];
    return Object.entries(mcpStatus).map(([name, status]) => ({ name, status }));
  }, [mcpStatus]);

  // Derive tools-per-server from tool IDs (tools prefixed with mcp_ or containing _mcp_)
  const serverTools = useMemo(() => {
    if (!toolIds) return {} as Record<string, string[]>;
    const result: Record<string, string[]> = {};
    for (const id of toolIds) {
      // MCP tool IDs follow the pattern: mcp_{serverName}_{toolName}
      const match = id.match(/^mcp_([^_]+)_(.+)$/);
      if (match) {
        const serverName = match[1];
        if (!result[serverName]) result[serverName] = [];
        result[serverName].push(match[2]);
      }
    }
    return result;
  }, [toolIds]);

  const handleAddServer = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    setAddError('');

    if (!addForm.name.trim()) {
      setAddError('Server name is required');
      return;
    }

    if (addForm.transportType === 'stdio' && !addForm.command.trim()) {
      setAddError('Command is required for stdio transport');
      return;
    }

    if (addForm.transportType === 'http' && !addForm.url.trim()) {
      setAddError('URL is required for HTTP transport');
      return;
    }

    if (addForm.transportType === 'http' && !/^https?:\/\//.test(addForm.url.trim())) {
      setAddError('URL must start with http:// or https://');
      return;
    }

    const envMap: Record<string, string> = {};
    for (const pair of addForm.envPairs) {
      if (pair.key.trim()) {
        envMap[pair.key.trim()] = pair.value;
      }
    }

    try {
      await addMutation.mutateAsync({
        name: addForm.name.trim(),
        type: addForm.transportType === 'stdio' ? 'local' : 'remote',
        ...(addForm.transportType === 'stdio'
          ? { command: addForm.command.trim().split(/\s+/), env: envMap }
          : { url: addForm.url.trim() }),
      });
      toast.info(`MCP server "${addForm.name.trim()}" added`);
      setAddForm({ name: '', transportType: 'stdio', command: '', url: '', envPairs: [] });
      setView({ type: 'list' });
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  }, [addForm, addMutation]);

  const handleConnect = useCallback(async (name: string) => {
    try {
      await connectMutation.mutateAsync(name);
      toast.info(`MCP server "${name}" connected`);
    } catch (err) {
      toast.warning(`Failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [connectMutation]);

  const handleDisconnect = useCallback(async (name: string) => {
    try {
      await disconnectMutation.mutateAsync(name);
      toast.info(`MCP server "${name}" disconnected`);
    } catch (err) {
      toast.warning(`Failed to disconnect "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [disconnectMutation]);

  const handleAuthStart = useCallback(async (name: string) => {
    setAuthError('');
    setAuthCode('');
    setAuthUrl('');
    setView({ type: 'auth', name });
    try {
      const result = await authStartMutation.mutateAsync(name);
      setAuthUrl(result.authorizationUrl);
      window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }, [authStartMutation]);

  const handleAuthCallback = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (view.type !== 'auth') return;
    if (!authCode.trim()) {
      setAuthError('Authorization code is required');
      return;
    }
    try {
      await authCallbackMutation.mutateAsync({ name: view.name, code: authCode.trim() });
      toast.info(`MCP server "${view.name}" authorized`);
      setView({ type: 'list' });
      setAuthCode('');
      setAuthUrl('');
      setAuthError('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    }
  }, [view, authCode, authCallbackMutation]);

  const addEnvPair = useCallback(() => {
    setAddForm((f) => ({ ...f, envPairs: [...f.envPairs, { key: '', value: '' }] }));
  }, []);

  const removeEnvPair = useCallback((index: number) => {
    setAddForm((f) => ({ ...f, envPairs: f.envPairs.filter((_, i) => i !== index) }));
  }, []);

  const updateEnvPair = useCallback((index: number, field: 'key' | 'value', val: string) => {
    setAddForm((f) => ({
      ...f,
      envPairs: f.envPairs.map((p, i) => (i === index ? { ...p, [field]: val } : p)),
    }));
  }, []);

  // ---- Auth view ----
  if (view.type === 'auth') {
    return (
      <div className="space-y-4 overflow-y-auto pr-1">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => { setView({ type: 'list' }); setAuthError(''); }}
            variant="ghost"
            size="icon-sm"
          >
            <ChevronRight className="h-4 w-4 rotate-180" />
          </Button>
          <h3 className="text-sm font-semibold">Authorize: {view.name}</h3>
        </div>

        {authStartMutation.isPending && !authUrl && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Starting authorization...</span>
          </div>
        )}

        {authUrl && (
          <form onSubmit={handleAuthCallback} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Visit the{' '}
              <a href={authUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                authorization page
              </a>{' '}
              and after it redirects to `localhost`, paste the full redirected URL below.
            </p>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Localhost Redirect URL</label>
              <Input type="text"
                placeholder="Paste http://localhost:.../callback?..."
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                autoFocus
              />
            </div>
            {authError && (
              <p className="text-sm text-destructive flex items-center gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                {authError}
              </p>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={authCallbackMutation.isPending}
              className="h-8 px-4 text-xs"
            >
              {authCallbackMutation.isPending ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1.5" />Authorizing...</>
              ) : (
                'Submit'
              )}
            </Button>
          </form>
        )}

        {authError && !authUrl && (
          <div className="space-y-3">
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {authError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAuthStart(view.name)}
              className="h-8 px-3 text-xs"
            >
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ---- Add form view ----
  if (view.type === 'add') {
    return (
      <div className="space-y-4 overflow-y-auto pr-1">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={() => { setView({ type: 'list' }); setAddError(''); }}
            variant="ghost"
            size="icon-sm"
          >
            <ChevronRight className="h-4 w-4 rotate-180" />
          </Button>
          <h3 className="text-sm font-semibold">Add MCP Server</h3>
        </div>

        <form onSubmit={handleAddServer} className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Server Name</label>
            <Input type="text"
              placeholder="my-server"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>

          {/* Transport Type */}
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground mb-1 block">Transport Type</label>
            <div className="flex gap-1.5">
              <Button
                type="button"
                onClick={() => setAddForm((f) => ({ ...f, transportType: 'stdio' }))}
                size="toolbar"
                variant={addForm.transportType === 'stdio' ? 'subtle' : 'muted'}
                className={cn(addForm.transportType === 'stdio' && 'border border-primary/20')}
              >
                Stdio (command)
              </Button>
              <Button
                type="button"
                onClick={() => setAddForm((f) => ({ ...f, transportType: 'http' }))}
                size="toolbar"
                variant={addForm.transportType === 'http' ? 'subtle' : 'muted'}
                className={cn(addForm.transportType === 'http' && 'border border-primary/20')}
              >
                HTTP (URL)
              </Button>
            </div>
          </div>

          {/* Transport-specific fields */}
          {addForm.transportType === 'stdio' ? (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Command</label>
              <Input type="text"
                placeholder="npx -y @modelcontextprotocol/server-github"
                value={addForm.command}
                onChange={(e) => setAddForm((f) => ({ ...f, command: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground/60 mt-1">
                Full command with arguments, space-separated
              </p>
            </div>
          ) : (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">URL</label>
              <Input type="text"
                placeholder="https://mcp.example.com/sse"
                value={addForm.url}
                onChange={(e) => setAddForm((f) => ({ ...f, url: e.target.value }))}
              />
            </div>
          )}

          {/* Environment Variables */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">Environment Variables</label>
              <Button
                type="button"
                onClick={addEnvPair}
                variant="muted"
                size="xs"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
            {addForm.envPairs.length > 0 && (
              <div className="space-y-2">
                {addForm.envPairs.map((pair, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <Input type="text"
                      placeholder="KEY"
                      value={pair.key}
                      onChange={(e) => updateEnvPair(i, 'key', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                    <Input type="text"
                      placeholder="value"
                      value={pair.value}
                      onChange={(e) => updateEnvPair(i, 'value', e.target.value)}
                      className="flex-1 text-xs"
                    />
                    <Button
                      type="button"
                      onClick={() => removeEnvPair(i)}
                      variant="ghost"
                      size="icon-xs"
                      className="hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {addError && (
            <p className="text-sm text-destructive flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {addError}
            </p>
          )}

          <Button
            type="submit"
            size="sm"
            disabled={addMutation.isPending}
            className="h-8 px-4 text-xs"
          >
            {addMutation.isPending ? (
              <><Loader2 className="h-3 w-3 animate-spin mr-1.5" />Adding...</>
            ) : (
              'Add Server'
            )}
          </Button>
        </form>
      </div>
    );
  }

  // ---- List view ----
  return (
    <div className="space-y-4 overflow-y-auto pr-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          Servers ({servers.length})
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2.5 text-xs gap-1.5"
          onClick={() => { setView({ type: 'add' }); setAddError(''); }}
        >
          <Plus className="h-3 w-3" />
          Add Server
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : servers.length > 0 ? (
        <div className="space-y-2">
          {servers.map(({ name, status }) => {
            const isExp = expanded === name;
            const tools = serverTools[name] ?? [];
            const isConnected = status.status === 'connected';
            const needsAuth = status.status === 'needs_auth' || status.status === 'needs_client_registration';
            const isFailed = status.status === 'failed';
            const isToggling =
              (connectMutation.isPending && connectMutation.variables === name) ||
              (disconnectMutation.isPending && disconnectMutation.variables === name);

            return (
              <div
                key={name}
                className="rounded-xl border border-border/50 bg-card overflow-hidden"
              >
                {/* Server header */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-muted/50 flex-shrink-0">
                    <Server className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground truncate">
                        {name}
                      </span>
                      <StatusBadge status={status} />
                    </div>
                    {tools.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {tools.length} tool{tools.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {isFailed && 'error' in status && (
                      <p className="text-xs text-red-500/80 truncate mt-0.5">
                        {(status as any).error}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {/* Auth button for servers needing authentication */}
                    {needsAuth && (
                      <Button
                        onClick={() => handleAuthStart(name)}
                        disabled={authStartMutation.isPending}
                        variant="ghost"
                        size="icon-sm"
                        className="text-amber-600 dark:text-amber-400 hover:bg-amber-500/10"
                        title="Authorize"
                      >
                        <Plug className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {/* Connect / Disconnect toggle */}
                    <Button
                      onClick={() => isConnected ? handleDisconnect(name) : handleConnect(name)}
                      disabled={isToggling}
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        isConnected ? 'hover:text-red-500 hover:bg-red-500/10' : 'hover:text-emerald-500 hover:bg-emerald-500/10',
                      )}
                      title={isConnected ? 'Disconnect' : 'Connect'}
                    >
                      {isToggling ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : isConnected ? (
                        <Power className="h-3.5 w-3.5" />
                      ) : (
                        <Plug className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* Tools expand/collapse */}
                {tools.length > 0 && (
                  <>
                    <Button
                      onClick={() => setExpanded(isExp ? null : name)}
                      variant="muted"
                      size="xs"
                    >
                      {isExp ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      {isExp ? 'Hide tools' : 'Show tools'}
                    </Button>

                    {isExp && (
                      <div className="border-t border-border/30 max-h-40 overflow-y-auto">
                        {tools.map((tool) => (
                          <div
                            key={tool}
                            className="flex items-center gap-2 px-3 py-1.5 text-xs text-foreground/80 hover:bg-muted/30"
                          >
                            <Wrench className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                            <span className="font-mono truncate">{tool}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Server className="h-6 w-6 text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No MCP servers configured</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Add an MCP server to extend available tools
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Main Dialog
// ============================================================================

export function OpenCodeSettingsDialog({
  open,
  onOpenChange,
  initialTab = 'general',
}: OpenCodeSettingsDialogProps) {
  const { data: config, isLoading } = useOpenCodeConfig();
  const updateMutation = useUpdateOpenCodeConfig();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [activeTab, setActiveTab] = useState<OpenCodeSettingsTab>(initialTab);

  const onDraft = useCallback((key: string, value: unknown) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const hasDraftChanges = Object.keys(draft).length > 0;

  const handleSave = useCallback(() => {
    if (!hasDraftChanges) return;
    updateMutation.mutate(draft as Partial<Config>, {
      onSuccess: () => {
        // Sync model change to client-side model store so the resolution
        // chain in use-opencode-local.ts picks it up immediately.
        if ('model' in draft) {
          if (typeof draft.model === 'string' && draft.model) {
            const idx = draft.model.indexOf('/');
            if (idx > 0 && idx < draft.model.length - 1) {
              setGlobalDefaultModel({
                providerID: draft.model.slice(0, idx),
                modelID: draft.model.slice(idx + 1),
              });
            }
          } else {
            // User selected "Auto-detect" — clear globalDefault
            setGlobalDefaultModel(undefined);
          }
        }
        setDraft({});
      },
    });
  }, [draft, hasDraftChanges, updateMutation]);

  const handleDiscard = useCallback(() => setDraft({}), []);

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value as OpenCodeSettingsTab);
  }, []);

  // Reset draft when dialog closes
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setDraft({});
        setActiveTab(initialTab);
      }
      onOpenChange(nextOpen);
    },
    [initialTab, onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    setActiveTab(initialTab);
  }, [initialTab, open]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
       <DialogContent
        className="sm:max-w-2xl max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden"
        aria-describedby="opencode-settings-desc"
      >
        <DialogHeader className="px-6 pt-5 pb-0 flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" />
            Settings
          </DialogTitle>
          <DialogDescription id="opencode-settings-desc" className="sr-only">
            Configure OpenCode settings including general options, providers, and
            permissions.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !config ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="px-6 pt-3 flex-shrink-0">
              <TabsList className="w-full">
                <TabsTrigger value="general" className="flex-1 gap-1.5">
                  <Settings className="h-3.5 w-3.5" />
                  General
                </TabsTrigger>
                <TabsTrigger value="providers" className="flex-1 gap-1.5">
                  <Zap className="h-3.5 w-3.5" />
                  Providers
                </TabsTrigger>
                <TabsTrigger value="permissions" className="flex-1 gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  Permissions
                </TabsTrigger>
                <TabsTrigger value="mcp" className="flex-1 gap-1.5">
                  <Server className="h-3.5 w-3.5" />
                  MCP Servers
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="px-6 py-4 flex-1 min-h-0 overflow-y-auto">
              {activeTab === 'general' && (
                <GeneralSection
                  draft={draft}
                  config={config}
                  onDraft={onDraft}
                />
              )}

              {activeTab === 'providers' && (
                <ProvidersSection onDirty={() => {}} />
              )}

              {activeTab === 'permissions' && (
                <PermissionsSection
                  draft={draft}
                  config={config}
                  onDraft={onDraft}
                />
              )}

              {activeTab === 'mcp' && (
                <McpServersSection />
              )}
            </div>

            {/* Save / Discard footer */}
            {hasDraftChanges && (
              <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-border/40 flex-shrink-0 bg-background">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDiscard}
                  className="h-8 px-3 text-xs gap-1.5"
                >
                  <RotateCcw className="h-3 w-3" />
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="h-8 px-4 text-xs gap-1.5"
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save Changes
                </Button>
              </div>
            )}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

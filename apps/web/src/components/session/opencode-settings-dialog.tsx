'use client';

import { useTranslations } from 'next-intl';

import { ModelSelector } from '@/components/session/model-selector';
import { flattenModels } from '@/components/session/session-chat-input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { List, ListRow } from '@/components/ui/list';
import { STATUS_BG, STATUS_BORDER, STATUS_TEXT, StatusDot } from '@/components/ui/status';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ProviderList } from '@/features/providers/provider-list';
import { setGlobalDefaultModel } from '@/hooks/opencode/use-model-store';
import type { Config } from '@/hooks/opencode/use-opencode-config';
import { useOpenCodeConfig, useUpdateOpenCodeConfig } from '@/hooks/opencode/use-opencode-config';
import type { McpStatus } from '@/hooks/opencode/use-opencode-mcp';
import {
  useAddMcpServer,
  useConnectMcpServer,
  useDisconnectMcpServer,
  useMcpAuthCallback,
  useMcpAuthStart,
  useOpenCodeMcpStatus,
} from '@/hooks/opencode/use-opencode-mcp';
import { useOpenCodeProviders, useOpenCodeToolIds } from '@/hooks/opencode/use-opencode-sessions';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useProviderModalStore } from '@/stores/provider-modal-store';
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plug,
  Plus,
  Power,
  RotateCcw,
  Save,
  Server,
  Settings,
  Shield,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        <label className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {tHardcodedUi.raw(
            'componentsSessionOpencodeSettingsDialog.line152JsxTextCustomInstructions',
          )}
        </label>
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw(
            'componentsSessionOpencodeSettingsDialog.line155JsxTextAdditionalInstructionFilePathsOnePerLineE',
          )}
        </p>
        <Textarea
          value={instructionsText}
          onChange={(e) => {
            const lines = e.target.value.split('\n').filter((l) => l.trim() !== '');
            onDraft('instructions', lines.length > 0 ? lines : undefined);
          }}
          placeholder={tHardcodedUi.raw(
            'componentsSessionOpencodeSettingsDialog.line165JsxAttrPlaceholderDocsRulesMd10Cursorrules10AgentsMd',
          )}
          rows={4}
          className="resize-none rounded-2xl font-mono text-sm"
        />
      </div>

      {/* Default Model */}
      <div className="space-y-2">
        <label className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line174JsxTextDefaultModel')}
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
              className="text-muted-foreground h-auto p-0 text-xs"
            >
              {tHardcodedUi.raw(
                'componentsSessionOpencodeSettingsDialog.line190JsxTextResetToAuto',
              )}
            </Button>
          )}
          {!selectedModel && <span className="text-muted-foreground/60 text-xs">Auto-detect</span>}
        </div>
      </div>

      {/* Snapshots */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
              Snapshots
            </label>
            <p className="text-muted-foreground/60 mt-0.5 text-xs">
              {tHardcodedUi.raw(
                'componentsSessionOpencodeSettingsDialog.line207JsxTextCreateAGitSnapshotAtEachAgenticStep',
              )}
            </p>
          </div>
          <Switch checked={snapshot} onCheckedChange={(v) => onDraft('snapshot', v)} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Providers Tab
// ============================================================================

function ProvidersSection({ onDirty }: { onDirty: () => void }) {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        <span className="text-muted-foreground/40 text-xs font-medium tracking-wider uppercase">
          {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line242JsxTextConnected')}
          {connectedProviders.length})
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: toolIds } = useOpenCodeToolIds();

  const permission = (draft.permission ?? config.permission ?? {}) as Record<string, any>;
  const isGlobalMode = typeof permission === 'string';
  const globalAction = isGlobalMode ? (permission as string) : 'ask';
  // Resolve the wildcard fallback: permission["*"] acts as the default for all tools
  const wildcardAction =
    !isGlobalMode && typeof (permission as Record<string, any>)['*'] === 'string'
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
        <label className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {tHardcodedUi.raw(
            'componentsSessionOpencodeSettingsDialog.line333JsxTextGlobalPermissionMode',
          )}
        </label>
        <p className="text-muted-foreground/60 text-xs">
          {tHardcodedUi.raw(
            'componentsSessionOpencodeSettingsDialog.line336JsxTextSetABlanketPermissionLevelOrConfigurePer',
          )}
        </p>
        <div className="flex gap-1.5">
          {ACTIONS.map((a) => (
            <Button
              key={a}
              onClick={() => setGlobalMode(a)}
              size="toolbar"
              variant={
                isGlobalMode && globalAction === a
                  ? a === 'allow'
                    ? 'success'
                    : a === 'deny'
                      ? 'destructive'
                      : 'muted'
                  : 'muted'
              }
              className={cn(
                isGlobalMode &&
                  globalAction === a &&
                  a === 'allow' &&
                  cn('border', STATUS_BG.success, STATUS_TEXT.success, STATUS_BORDER.success),
                isGlobalMode &&
                  globalAction === a &&
                  a === 'deny' &&
                  'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15 border',
                isGlobalMode &&
                  globalAction === a &&
                  a === 'ask' &&
                  cn('border', STATUS_BG.warning, STATUS_TEXT.warning, STATUS_BORDER.warning),
              )}
            >
              {a}
            </Button>
          ))}
          <Button
            onClick={() => {
              if (isGlobalMode) {
                onDraft('permission', {});
              }
            }}
            size="toolbar"
            variant="muted"
            className={cn(
              !isGlobalMode && cn('border', STATUS_BG.info, STATUS_TEXT.info, STATUS_BORDER.info),
            )}
          >
            per-tool
          </Button>
        </div>
      </div>

      {/* Per-tool permission overrides */}
      {!isGlobalMode && (
        <div className="space-y-2">
          <label className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {tHardcodedUi.raw(
              'componentsSessionOpencodeSettingsDialog.line375JsxTextPerToolPermissions',
            )}
          </label>
          <div className="border-border/50 bg-card rounded-2xl border">
            <List>
              {PERMISSION_TYPES.map(({ key, label, description }) => (
                <ListRow
                  key={key}
                  className="px-3 py-2.5"
                  title={label}
                  subtitle={<p className="text-muted-foreground/60 text-xs">{description}</p>}
                  trailing={ACTIONS.map((a) => (
                    <Button
                      key={a}
                      onClick={() => setAction(key, a)}
                      size="xs"
                      variant="muted"
                      className={cn(
                        getAction(key) === a &&
                          a === 'allow' &&
                          cn(
                            'border',
                            STATUS_BG.success,
                            STATUS_TEXT.success,
                            STATUS_BORDER.success,
                          ),
                        getAction(key) === a &&
                          a === 'deny' &&
                          'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15 border',
                        getAction(key) === a &&
                          a === 'ask' &&
                          cn(
                            'border',
                            STATUS_BG.warning,
                            STATUS_TEXT.warning,
                            STATUS_BORDER.warning,
                          ),
                      )}
                    >
                      {a}
                    </Button>
                  ))}
                />
              ))}
            </List>
          </div>
        </div>
      )}

      {/* Tool enable/disable overrides */}
      {builtinToolIds.length > 0 && (
        <div className="space-y-2">
          <label className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            {tHardcodedUi.raw(
              'componentsSessionOpencodeSettingsDialog.line411JsxTextToolOverrides',
            )}
          </label>
          <p className="text-muted-foreground/60 text-xs">
            {tHardcodedUi.raw(
              'componentsSessionOpencodeSettingsDialog.line414JsxTextEnableOrDisableIndividualTools',
            )}
          </p>
          <div className="border-border/50 bg-card max-h-48 overflow-y-auto rounded-2xl border">
            <List>
              {builtinToolIds.map((id) => (
                <ListRow
                  key={id}
                  className="px-3 py-2"
                  title={
                    <span className="text-foreground/80 truncate font-mono text-xs">{id}</span>
                  }
                  trailing={
                    <Switch checked={isToolEnabled(id)} onCheckedChange={() => toggleTool(id)} />
                  }
                />
              ))}
            </List>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
  const s = status.status;
  if (s === 'connected') {
    return (
      <Badge size="sm" variant="success">
        <StatusDot tone="success" />
        connected
      </Badge>
    );
  }
  if (s === 'disabled') {
    return (
      <Badge size="sm" variant="secondary">
        <StatusDot tone="neutral" />
        disconnected
      </Badge>
    );
  }
  if (s === 'needs_auth' || s === 'needs_client_registration') {
    return (
      <Badge size="sm" variant="warning">
        <StatusDot tone="warning" />
        {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line467JsxTextNeedsAuth')}
      </Badge>
    );
  }
  // failed
  return (
    <Badge size="sm" variant="outline" className="bg-destructive/10 text-destructive">
      <span className="bg-destructive h-1.5 w-1.5 rounded-full" />
      error
    </Badge>
  );
}

function McpServersSection() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  const handleAddServer = useCallback(
    async (e?: React.FormEvent) => {
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
    },
    [addForm, addMutation],
  );

  const handleConnect = useCallback(
    async (name: string) => {
      try {
        await connectMutation.mutateAsync(name);
        toast.info(`MCP server "${name}" connected`);
      } catch (err) {
        toast.warning(
          `Failed to connect "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [connectMutation],
  );

  const handleDisconnect = useCallback(
    async (name: string) => {
      try {
        await disconnectMutation.mutateAsync(name);
        toast.info(`MCP server "${name}" disconnected`);
      } catch (err) {
        toast.warning(
          `Failed to disconnect "${name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [disconnectMutation],
  );

  const handleAuthStart = useCallback(
    async (name: string) => {
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
    },
    [authStartMutation],
  );

  const handleAuthCallback = useCallback(
    async (e?: React.FormEvent) => {
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
    },
    [view, authCode, authCallbackMutation],
  );

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
            onClick={() => {
              setView({ type: 'list' });
              setAuthError('');
            }}
            variant="ghost"
            size="icon-sm"
          >
            <ChevronRight className="h-4 w-4 rotate-180" />
          </Button>
          <h3 className="text-sm font-semibold">Authorize: {view.name}</h3>
        </div>

        {authStartMutation.isPending && !authUrl && (
          <div className="flex items-center gap-3 py-4">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
            <span className="text-muted-foreground text-sm">
              {tHardcodedUi.raw(
                'componentsSessionOpencodeSettingsDialog.line660JsxTextStartingAuthorization',
              )}
            </span>
          </div>
        )}

        {authUrl && (
          <form onSubmit={handleAuthCallback} className="space-y-4">
            <p className="text-muted-foreground text-sm">
              {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line667JsxTextVisitThe')}{' '}
              <a
                href={authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line669JsxTextAuthorizationPage',
                )}
              </a>{' '}
              {tHardcodedUi.raw(
                'componentsSessionOpencodeSettingsDialog.line671JsxTextAndAfterItRedirectsToLocalhostPasteThe',
              )}
            </p>
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">
                {tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line674JsxTextLocalhostRedirectUrl',
                )}
              </label>
              <Input
                type="text"
                placeholder={tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line676JsxAttrPlaceholderPasteHttpLocalhostCallback',
                )}
                value={authCode}
                onChange={(e) => setAuthCode(e.target.value)}
                autoFocus
              />
            </div>
            {authError && (
              <p className="text-destructive flex items-center gap-1.5 text-sm">
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
                <>
                  <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  Authorizing...
                </>
              ) : (
                'Submit'
              )}
            </Button>
          </form>
        )}

        {authError && !authUrl && (
          <div className="space-y-3">
            <p className="text-destructive flex items-center gap-1.5 text-sm">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {authError}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAuthStart(view.name)}
              className="h-8 px-3 text-xs"
            >
              {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line715JsxTextTryAgain')}
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
            onClick={() => {
              setView({ type: 'list' });
              setAddError('');
            }}
            variant="ghost"
            size="icon-sm"
          >
            <ChevronRight className="h-4 w-4 rotate-180" />
          </Button>
          <h3 className="text-sm font-semibold">
            {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line736JsxTextAddMcpServer')}
          </h3>
        </div>

        <form onSubmit={handleAddServer} className="space-y-4">
          {/* Name */}
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">
              {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line742JsxTextServerName')}
            </label>
            <Input
              type="text"
              placeholder="my-server"
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
            />
          </div>

          {/* Transport Type */}
          <div className="space-y-2">
            <label className="text-muted-foreground mb-1 block text-xs">
              {tHardcodedUi.raw(
                'componentsSessionOpencodeSettingsDialog.line753JsxTextTransportType',
              )}
            </label>
            <div className="flex gap-1.5">
              <Button
                type="button"
                onClick={() => setAddForm((f) => ({ ...f, transportType: 'stdio' }))}
                size="toolbar"
                variant={addForm.transportType === 'stdio' ? 'secondary' : 'muted'}
                className={cn(addForm.transportType === 'stdio' && 'border-primary/20 border')}
              >
                {tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line762JsxTextStdioCommand',
                )}
              </Button>
              <Button
                type="button"
                onClick={() => setAddForm((f) => ({ ...f, transportType: 'http' }))}
                size="toolbar"
                variant={addForm.transportType === 'http' ? 'secondary' : 'muted'}
                className={cn(addForm.transportType === 'http' && 'border-primary/20 border')}
              >
                {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line771JsxTextHttpUrl')}
              </Button>
            </div>
          </div>

          {/* Transport-specific fields */}
          {addForm.transportType === 'stdio' ? (
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">Command</label>
              <Input
                type="text"
                placeholder={tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line781JsxAttrPlaceholderNpxYModelcontextprotocolServerGithub',
                )}
                value={addForm.command}
                onChange={(e) => setAddForm((f) => ({ ...f, command: e.target.value }))}
              />
              <p className="text-muted-foreground/60 mt-1 text-xs">
                {tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line786JsxTextFullCommandWithArgumentsSpaceSeparated',
                )}
              </p>
            </div>
          ) : (
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">URL</label>
              <Input
                type="text"
                placeholder="https://mcp.example.com/sse"
                value={addForm.url}
                onChange={(e) => setAddForm((f) => ({ ...f, url: e.target.value }))}
              />
            </div>
          )}

          {/* Environment Variables */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-muted-foreground text-xs">
                {tHardcodedUi.raw(
                  'componentsSessionOpencodeSettingsDialog.line803JsxTextEnvironmentVariables',
                )}
              </label>
              <Button type="button" onClick={addEnvPair} variant="muted" size="xs">
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
            {addForm.envPairs.length > 0 && (
              <div className="space-y-2">
                {addForm.envPairs.map((pair, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="text"
                      placeholder="KEY"
                      value={pair.key}
                      onChange={(e) => updateEnvPair(i, 'key', e.target.value)}
                      className="flex-1 font-mono text-xs"
                    />
                    <Input
                      type="text"
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
                      className="hover:text-foreground hover:bg-muted flex-shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {addError && (
            <p className="text-destructive flex items-center gap-1.5 text-sm">
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
              <>
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                Adding...
              </>
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
        <span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line874JsxTextServers')}
          {servers.length})
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2.5 text-xs"
          onClick={() => {
            setView({ type: 'add' });
            setAddError('');
          }}
        >
          <Plus className="h-3 w-3" />
          {tHardcodedUi.raw('componentsSessionOpencodeSettingsDialog.line883JsxTextAddServer')}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
        </div>
      ) : servers.length > 0 ? (
        <div className="space-y-2">
          {servers.map(({ name, status }) => {
            const isExp = expanded === name;
            const tools = serverTools[name] ?? [];
            const isConnected = status.status === 'connected';
            const needsAuth =
              status.status === 'needs_auth' || status.status === 'needs_client_registration';
            const isFailed = status.status === 'failed';
            const isToggling =
              (connectMutation.isPending && connectMutation.variables === name) ||
              (disconnectMutation.isPending && disconnectMutation.variables === name);

            return (
              <div
                key={name}
                className="border-border/50 bg-card overflow-hidden rounded-2xl border"
              >
                {/* Server header */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="bg-muted/50 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg">
                    <Server className="text-muted-foreground h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">{name}</span>
                      <StatusBadge status={status} />
                    </div>
                    {tools.length > 0 && (
                      <span className="text-muted-foreground text-xs">
                        {tools.length} tool{tools.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    {isFailed && 'error' in status && (
                      <p className={cn('mt-0.5 truncate text-xs', STATUS_TEXT.destructive)}>
                        {(status as any).error}
                      </p>
                    )}
                  </div>

                  <div className="flex flex-shrink-0 items-center gap-1">
                    {/* Auth button for servers needing authentication */}
                    {needsAuth && (
                      <Button
                        onClick={() => handleAuthStart(name)}
                        disabled={authStartMutation.isPending}
                        variant="ghost"
                        size="icon-sm"
                        className={cn(STATUS_TEXT.warning, 'hover:bg-amber-500/10')}
                        title="Authorize"
                      >
                        <Plug className="h-3.5 w-3.5" />
                      </Button>
                    )}

                    {/* Connect / Disconnect toggle */}
                    <Button
                      onClick={() => (isConnected ? handleDisconnect(name) : handleConnect(name))}
                      disabled={isToggling}
                      variant="ghost"
                      size="icon-sm"
                      className={cn(
                        isConnected
                          ? 'hover:text-foreground hover:bg-muted'
                          : 'hover:bg-emerald-500/10 hover:text-emerald-500',
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
                      <div className="border-border/30 max-h-40 overflow-y-auto border-t">
                        {tools.map((tool) => (
                          <div
                            key={tool}
                            className="text-foreground/80 hover:bg-muted/30 flex items-center gap-2 px-3 py-1.5 text-xs"
                          >
                            <Wrench className="text-muted-foreground h-3 w-3 flex-shrink-0" />
                            <span className="truncate font-mono">{tool}</span>
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
          <Server className="text-muted-foreground mb-2 h-6 w-6" />
          <p className="text-muted-foreground text-sm">
            {tHardcodedUi.raw(
              'componentsSessionOpencodeSettingsDialog.line1007JsxTextNoMcpServersConfigured',
            )}
          </p>
          <p className="text-muted-foreground/60 mt-1 text-xs">
            {tHardcodedUi.raw(
              'componentsSessionOpencodeSettingsDialog.line1009JsxTextAddAnMcpServerToExtendAvailableTools',
            )}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
        className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        aria-describedby="opencode-settings-desc"
      >
        <DialogHeader className="flex-shrink-0 px-6 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Settings className="h-4 w-4" />
            Settings
          </DialogTitle>
          <DialogDescription id="opencode-settings-desc" className="sr-only">
            {tHardcodedUi.raw(
              'componentsSessionOpencodeSettingsDialog.line1097JsxTextConfigureOpencodeSettingsIncludingGeneralOptionsProvidersAnd',
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading || !config ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="text-muted-foreground h-4 w-4 animate-spin" />
          </div>
        ) : (
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
          >
            <div className="flex-shrink-0 px-6 pt-3">
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
                  {tHardcodedUi.raw(
                    'componentsSessionOpencodeSettingsDialog.line1124JsxTextMcpServers',
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              {activeTab === 'general' && (
                <GeneralSection draft={draft} config={config} onDraft={onDraft} />
              )}

              {activeTab === 'providers' && <ProvidersSection onDirty={() => {}} />}

              {activeTab === 'permissions' && (
                <PermissionsSection draft={draft} config={config} onDraft={onDraft} />
              )}

              {activeTab === 'mcp' && <McpServersSection />}
            </div>

            {/* Save / Discard footer */}
            {hasDraftChanges && (
              <div className="border-border/40 bg-background flex flex-shrink-0 items-center justify-end gap-2 border-t px-6 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDiscard}
                  className="h-8 gap-1.5 px-3 text-xs"
                >
                  <RotateCcw className="h-3 w-3" />
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="h-8 gap-1.5 px-4 text-xs"
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  {tHardcodedUi.raw(
                    'componentsSessionOpencodeSettingsDialog.line1178JsxTextSaveChanges',
                  )}
                </Button>
              </div>
            )}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

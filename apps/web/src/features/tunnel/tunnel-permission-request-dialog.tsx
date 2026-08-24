'use client';

import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  useApprovePermissionRequest,
  useDenyPermissionRequest,
  type TunnelPermissionRequest,
} from '@/hooks/tunnel/use-tunnel';
import { cn } from '@/lib/utils';
import { useTunnelStore } from '@/stores/tunnel-store';
import {
  WarningIcon as AlertTriangle,
  CaretDownIcon as ChevronDown,
  ClockIcon as Clock,
  ShieldIcon as Shield,
  XIcon as X,
} from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';
import { getScopeEditorCapability } from './scope-editors';
import { FilesystemScopeEditor } from './scope-editors/filesystem-scope-editor';
import { ShellScopeEditor } from './scope-editors/shell-scope-editor';
import type { FilesystemScope, PermissionScope, ShellScope } from './types';
import { EXPIRY_OPTIONS, getCapabilityInfo, getDefaultScope, getExpiresAt } from './types';

type Mode = 'once' | 'scoped' | 'all';

export function TunnelPermissionRequestDialog() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const pendingRequests = useTunnelStore((s) => s.pendingRequests);
  const removePendingRequest = useTunnelStore((s) => s.removePendingRequest);

  const approveMutation = useApprovePermissionRequest();
  const denyMutation = useDenyPermissionRequest();

  const currentRequest = pendingRequests[0];
  const [mode, setMode] = useState<Mode>('scoped');
  const [expiryValue, setExpiryValue] = useState('7d');
  const [scopeExpanded, setScopeExpanded] = useState(false);

  // Pre-fill scope from the request
  const initialScope = useMemo(() => {
    if (!currentRequest) return {};
    return extractScopeFromRequest(currentRequest);
  }, [currentRequest]);

  const [customScope, setCustomScope] = useState<PermissionScope>(initialScope);

  // Reset state when the request changes
  useEffect(() => {
    if (currentRequest) {
      setMode('scoped');
      setExpiryValue('7d');
      setScopeExpanded(false);
      setCustomScope(extractScopeFromRequest(currentRequest));
    }
  }, [currentRequest]);

  if (!currentRequest) return null;

  const capInfo = getCapabilityInfo(currentRequest.capability);
  const scopeEditorType = getScopeEditorCapability(currentRequest.capability);
  const isPending = approveMutation.isPending || denyMutation.isPending;

  const handleApprove = async () => {
    try {
      let scope: Record<string, unknown> | undefined;
      let expiresAt: string | undefined;

      if (mode === 'once') {
        scope = currentRequest.requestedScope;
        expiresAt = getExpiresAt(EXPIRY_OPTIONS[0]!);
      } else if (mode === 'scoped') {
        scope = customScope as Record<string, unknown>;
        const expiry = EXPIRY_OPTIONS.find((o) => o.value === expiryValue);
        expiresAt = expiry ? getExpiresAt(expiry) : undefined;
      } else {
        scope = {};
        const expiry = EXPIRY_OPTIONS.find((o) => o.value === expiryValue);
        expiresAt = expiry ? getExpiresAt(expiry) : undefined;
      }

      await approveMutation.mutateAsync({
        requestId: currentRequest.requestId,
        scope,
        expiresAt,
      });
      removePendingRequest(currentRequest.requestId);
      successToast(`Granted ${currentRequest.capability} access`);
    } catch (err) {
      console.error('Failed to approve:', err);
      errorToast('Failed to grant access', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleDeny = async () => {
    try {
      await denyMutation.mutateAsync(currentRequest.requestId);
      removePendingRequest(currentRequest.requestId);
      successToast('Request denied');
    } catch (err) {
      console.error('Failed to deny:', err);
      errorToast('Failed to deny request', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <Dialog open={!!currentRequest} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            {tHardcodedUi.raw(
              'componentsTunnelTunnelPermissionRequestDialog.line109JsxTextPermissionRequest',
            )}
          </DialogTitle>
          <DialogDescription>
            {tHardcodedUi.raw(
              'componentsTunnelTunnelPermissionRequestDialog.line112JsxTextYourAiAgentIsRequesting',
            )}
            <span className="text-foreground font-medium">{currentRequest.capability}</span> access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-center gap-2">
            <Shield className="text-muted-foreground h-4 w-4" />
            <Badge variant="secondary">{currentRequest.capability}</Badge>
            {capInfo && (
              <span className="text-muted-foreground text-xs">{capInfo.description}</span>
            )}
          </div>

          {currentRequest.reason && (
            <div className="bg-muted/50 rounded-2xl p-3 text-sm">{currentRequest.reason}</div>
          )}

          <div className="space-y-1.5">
            <ModeOption
              active={mode === 'once'}
              onClick={() => setMode('once')}
              label={tHardcodedUi.raw(
                'componentsTunnelTunnelPermissionRequestDialog.line135JsxAttrLabelAllowThisOnce',
              )}
              description={tHardcodedUi.raw(
                'componentsTunnelTunnelPermissionRequestDialog.line136JsxAttrDescriptionExactScopeExpiresIn1Hour',
              )}
            />
            <ModeOption
              active={mode === 'scoped'}
              onClick={() => setMode('scoped')}
              label={tHardcodedUi.raw(
                'componentsTunnelTunnelPermissionRequestDialog.line141JsxAttrLabelAddToPermissions',
              )}
              description={tHardcodedUi.raw(
                'componentsTunnelTunnelPermissionRequestDialog.line142JsxAttrDescriptionConfigureScopeAndExpiry',
              )}
              isDefault
            />
            <ModeOption
              active={mode === 'all'}
              onClick={() => setMode('all')}
              label={`Allow all ${capInfo?.label || currentRequest.capability}`}
              description={tHardcodedUi.raw(
                'componentsTunnelTunnelPermissionRequestDialog.line149JsxAttrDescriptionUnrestrictedAccessToThisCapability',
              )}
            />
          </div>

          {mode === 'scoped' && scopeEditorType && (
            <Collapsible open={scopeExpanded} onOpenChange={setScopeExpanded}>
              <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1.5 text-xs font-medium transition-colors">
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 transition-transform',
                    scopeExpanded ? '' : '-rotate-90',
                  )}
                />
                {tHardcodedUi.raw(
                  'componentsTunnelTunnelPermissionRequestDialog.line157JsxTextConfigureScope',
                )}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="pt-2">
                  {scopeEditorType === 'filesystem' && (
                    <FilesystemScopeEditor
                      scope={customScope as FilesystemScope}
                      onChange={(s) => setCustomScope(s)}
                    />
                  )}
                  {scopeEditorType === 'shell' && (
                    <ShellScopeEditor
                      scope={customScope as ShellScope}
                      onChange={(s) => setCustomScope(s)}
                    />
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {mode !== 'once' && (
            <div className="flex items-center gap-2">
              <Clock className="text-muted-foreground h-3.5 w-3.5" />
              <span className="text-muted-foreground text-xs">Expires:</span>
              <Select value={expiryValue} onValueChange={setExpiryValue}>
                <SelectTrigger size="sm" className="w-[120px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {pendingRequests.length > 1 && (
            <p className="text-muted-foreground text-xs">
              +{pendingRequests.length - 1}
              {tHardcodedUi.raw(
                'componentsTunnelTunnelPermissionRequestDialog.line203JsxTextMoreRequest',
              )}{' '}
              {pendingRequests.length > 2 ? 's' : ''} pending
            </p>
          )}
        </div>

        <DialogFooter className="flex gap-2 sm:gap-2">
          <Button variant="outline" onClick={handleDeny} disabled={isPending} className="flex-1">
            <X className="mr-1 h-4 w-4" />
            Deny
          </Button>
          <Button onClick={handleApprove} disabled={isPending} className="flex-1">
            {mode === 'once'
              ? 'Allow Once'
              : mode === 'scoped'
                ? 'Grant Permission'
                : `Allow All ${capInfo?.label || ''}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModeOption({
  active,
  onClick,
  label,
  description,
  isDefault,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  description: string;
  isDefault?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full rounded-2xl border px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border hover:border-border/80 hover:bg-muted/30',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-3.5 w-3.5 shrink-0 rounded-full border-2',
            active ? 'border-primary bg-primary' : 'border-muted-foreground/40',
          )}
        />
        <span className="text-sm font-medium">{label}</span>
        {isDefault && (
          <Badge variant="secondary" className="px-1.5 py-0 text-xs">
            Default
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground mt-0.5 ml-[22px] text-xs">{description}</p>
    </button>
  );
}

function extractScopeFromRequest(request: TunnelPermissionRequest): PermissionScope {
  const base = getDefaultScope(request.capability);
  const rs = request.requestedScope || {};

  switch (request.capability) {
    case 'filesystem': {
      const fsBase = base as FilesystemScope;
      const path = (rs as Record<string, unknown>).path as string | undefined;
      const operation = (rs as Record<string, unknown>).operation as string | undefined;
      return {
        ...fsBase,
        paths: path ? [path] : fsBase.paths,
        operations: operation
          ? [operation as FilesystemScope['operations'][number]]
          : fsBase.operations,
      } satisfies FilesystemScope;
    }
    case 'shell': {
      const shBase = base as ShellScope;
      const command = (rs as Record<string, unknown>).command as string | undefined;
      return {
        ...shBase,
        commands: command ? [command.split(' ')[0]!] : shBase.commands,
      } satisfies ShellScope;
    }
    default:
      return base;
  }
}

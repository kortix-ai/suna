'use client';

import { useTranslations } from 'next-intl';

import React, { useState, useMemo } from 'react';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  useTunnelPermissions,
  useGrantTunnelPermission,
  useRevokeTunnelPermission,
} from '@/hooks/tunnel/use-tunnel';
import { SCOPE_REGISTRY, EXPIRY_OPTIONS, getExpiresAt } from './types';
import type { ScopeInfo } from './types';

interface TunnelScopeTogglesProps {
  tunnelId: string;
}

function groupBy<T>(arr: T[], fn: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const key = fn(item);
    (result[key] ||= []).push(item);
  }
  return result;
}

export function TunnelScopeToggles({ tunnelId }: TunnelScopeTogglesProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: permissions, isLoading } = useTunnelPermissions(tunnelId);
  const grantMutation = useGrantTunnelPermission();
  const revokeMutation = useRevokeTunnelPermission();
  const [expiryValue, setExpiryValue] = useState('never');

  const groups = useMemo(() => groupBy(SCOPE_REGISTRY, (s) => s.category), []);

  const activeScopeMap = useMemo(() => {
    const map = new Map<string, string>();
    if (!permissions) return map;
    for (const p of permissions) {
      if (p.status !== 'active') continue;
      const scopeKey = (p.scope as Record<string, unknown>)?.scope as string | undefined;
      if (scopeKey) {
        map.set(scopeKey, p.permissionId);
      }
    }
    return map;
  }, [permissions]);

  const handleToggle = async (scope: ScopeInfo, isCurrentlyActive: boolean) => {
    if (isCurrentlyActive) {
      const permissionId = activeScopeMap.get(scope.key);
      if (permissionId) {
        await revokeMutation.mutateAsync({ tunnelId, permissionId });
      }
    } else {
      const expiryOption = EXPIRY_OPTIONS.find((o) => o.value === expiryValue) || EXPIRY_OPTIONS[EXPIRY_OPTIONS.length - 1];
      await grantMutation.mutateAsync({
        tunnelId,
        capability: scope.capability,
        scope: { scope: scope.key },
        expiresAt: getExpiresAt(expiryOption),
      });
    }
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">{tHardcodedUi.raw('componentsTunnelTunnelScopeToggles.line73JsxTextLoadingPermissions')}</div>;
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">{tHardcodedUi.raw('componentsTunnelTunnelScopeToggles.line79JsxTextNewGrantsExpireIn')}</span>
        <Select value={expiryValue} onValueChange={setExpiryValue}>
          <SelectTrigger className="w-[120px] h-8 text-xs cursor-pointer hover:bg-muted/50 transition-colors">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                className="cursor-pointer transition-colors data-[highlighted]:bg-muted/70"
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {Object.entries(groups).map(([category, scopes]) => (
        <div key={category}>
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
            {category}
          </h4>
          <div className="space-y-1">
            {scopes.map((scope) => {
              const isActive = activeScopeMap.has(scope.key);
              return (
                <ScopeToggleRow
                  key={scope.key}
                  scope={scope}
                  isActive={isActive}
                  isPending={grantMutation.isPending || revokeMutation.isPending}
                  onToggle={() => handleToggle(scope, isActive)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ScopeToggleRow({
  scope,
  isActive,
  isPending,
  onToggle,
}: {
  scope: ScopeInfo;
  isActive: boolean;
  isPending: boolean;
  onToggle: () => void;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors',
        'hover:bg-muted/50',
        isActive && 'bg-primary/5',
      )}
    >
      <Switch
        checked={isActive}
        onCheckedChange={onToggle}
        disabled={isPending}
        className="shrink-0"
      />
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {isActive && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
        )}
        <code className="text-xs font-mono text-foreground">{scope.key}</code>
        <span className="text-xs text-muted-foreground truncate">
          — {scope.description}
        </span>
      </div>
    </label>
  );
}

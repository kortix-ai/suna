'use client';

import { useTranslations } from 'next-intl';

import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  useGrantTunnelPermission,
  useRevokeTunnelPermission,
  useTunnelPermissions,
} from '@/hooks/tunnel/use-tunnel';
import { cn } from '@/lib/utils';
import { Fragment, useMemo, useState } from 'react';
import type { ScopeInfo } from './types';
import { EXPIRY_OPTIONS, getExpiresAt, SCOPE_REGISTRY } from './types';
import type { TunnelPermission } from '@/hooks/tunnel/use-tunnel';

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

export function buildActiveScopeMap(permissions: TunnelPermission[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!permissions) return map;
  for (const p of permissions) {
    if (p.status !== 'active') continue;
    const scopeKey = (p.scope as Record<string, unknown>)?.scope as string | undefined;
    if (scopeKey) {
      map.set(scopeKey, p.permissionId);
      continue;
    }
    if (!p.scope || Object.keys(p.scope as Record<string, unknown>).length === 0) {
      for (const scope of SCOPE_REGISTRY) {
        if (scope.capability === p.capability && !map.has(scope.key)) {
          map.set(scope.key, p.permissionId);
        }
      }
    }
  }
  return map;
}

export function TunnelScopeToggles({ tunnelId }: TunnelScopeTogglesProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const { data: permissions, isLoading } = useTunnelPermissions(tunnelId);
  const grantMutation = useGrantTunnelPermission();
  const revokeMutation = useRevokeTunnelPermission();
  const [expiryValue, setExpiryValue] = useState('never');

  const groups = useMemo(() => groupBy(SCOPE_REGISTRY, (s) => s.category), []);

  const activeScopeMap = useMemo(() => buildActiveScopeMap(permissions), [permissions]);

  const handleToggle = async (scope: ScopeInfo, isCurrentlyActive: boolean) => {
    if (isCurrentlyActive) {
      const permissionId = activeScopeMap.get(scope.key);
      if (permissionId) {
        await revokeMutation.mutateAsync({ tunnelId, permissionId });
      }
    } else {
      const expiryOption =
        EXPIRY_OPTIONS.find((o) => o.value === expiryValue) ||
        EXPIRY_OPTIONS[EXPIRY_OPTIONS.length - 1];
      await grantMutation.mutateAsync({
        tunnelId,
        capability: scope.capability,
        // `scope` marks which toggle this is (for read-back); the spread fields
        // are what the backend checker actually enforces. Without them a grant
        // is allow-all for the capability.
        scope: { scope: scope.key, ...(scope.grantScope ?? {}) },
        expiresAt: getExpiresAt(expiryOption),
      });
    }
  };

  if (isLoading) {
    return (
      <div className="text-muted-foreground text-sm">
        {tHardcodedUi.raw('componentsTunnelTunnelScopeToggles.line73JsxTextLoadingPermissions')}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex w-full items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">
          {tHardcodedUi.raw('componentsTunnelTunnelScopeToggles.line79JsxTextNewGrantsExpireIn')}
        </span>
        <Select value={expiryValue} onValueChange={setExpiryValue}>
          <SelectTrigger variant="popover">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRY_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                // className="data-[highlighted]:bg-muted/70 cursor-pointer transition-colors"
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {Object.entries(groups).map(([category, scopes], index) => (
        <Fragment key={category}>
          {index > 0 && <Separator className='opacity-50'/>}
          <div>
            <Label>{category}</Label>
            <div className="space-y-2">
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
        </Fragment>
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
      className={cn('flex cursor-pointer items-center gap-3 rounded-md py-2 transition-colors')}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <code className="text-foreground font-mono text-xs">{scope.key}</code>
        <span className="text-muted-foreground truncate text-xs">— {scope.description}</span>
      </div>
      <Switch
        checked={isActive}
        onCheckedChange={onToggle}
        disabled={isPending}
        className="shrink-0"
      />
    </label>
  );
}

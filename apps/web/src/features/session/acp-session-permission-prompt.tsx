'use client';

/**
 * ACP port of main's `SessionPermissionPrompt` — the amber "agent needs your
 * permission" card, pinned above the composer via `SessionChatInput`'s
 * `inputSlot`. Answering resumes the harness's already-blocked turn in place
 * (the ACP peer holds `session/request_permission` open until we respond), so
 * no follow-up "continue" message is ever needed.
 *
 * Unlike opencode's fixed once/always/reject reply kinds, ACP permission
 * requests carry their own dynamic `options` list (see
 * `resolvePermissionActionOptions`) — this renders the standard three-tier
 * layout when the harness offers the ACP-standard `allow_once`/`allow_always`/
 * `reject_*` kinds (or anything that looks like them), and still surfaces
 * whatever options exist otherwise so nothing is ever silently dropped.
 *
 * "Allow everything for this session" is client-side state owned by
 * `useAcpSession` (survives this component remounting); there is no
 * project-level "always allow" config plumbing on this branch (unlike main's
 * opencode permission config) — TODO(acp-project-permission-policy): wire one
 * up if/when the backend gains a per-project ACP permission policy surface.
 */

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { PERMISSION_LABELS } from '@/ui/types';
import {
  resolvePermissionActionOptions,
  type AcpJsonRpcId,
  type AcpPendingOption,
  type AcpPendingPermission,
} from '@kortix/sdk';
import { ShieldCheck } from 'lucide-react';
import { useCallback, useState } from 'react';

interface AcpSessionPermissionPromptProps {
  permissions: AcpPendingPermission[];
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  onReply: (id: AcpJsonRpcId, optionId?: string) => Promise<void> | void;
}

function permissionLabel(permission: AcpPendingPermission): string {
  return PERMISSION_LABELS[permission.permission] || permission.permission;
}

function optionValue(option: AcpPendingOption): string {
  return String(option.optionId ?? option.id ?? option.value ?? '');
}

export function AcpSessionPermissionPrompt({
  permissions,
  autoApprove,
  onAutoApproveChange,
  onReply,
}: AcpSessionPermissionPromptProps) {
  // Which button is loading: `${idKey}:once|session|deny`, or 'session-all'.
  const [busy, setBusy] = useState<string | null>(null);

  const reply = useCallback(
    async (permission: AcpPendingPermission, kind: 'once' | 'session' | 'deny', option: AcpPendingOption | null) => {
      const idKey = JSON.stringify(permission.id);
      setBusy(`${idKey}:${kind}`);
      try {
        await onReply(permission.id, option ? optionValue(option) : undefined);
      } catch (e) {
        errorToast(e instanceof Error ? e.message : 'Failed to answer the permission request');
      } finally {
        setBusy(null);
      }
    },
    [onReply],
  );

  const allowAllForSession = useCallback(async () => {
    setBusy('session-all');
    try {
      onAutoApproveChange(true);
      await Promise.all(
        permissions.map((permission) => {
          const { allowOnce } = resolvePermissionActionOptions(permission.options);
          return onReply(permission.id, allowOnce ? optionValue(allowOnce) : undefined);
        }),
      );
    } catch (e) {
      errorToast(e instanceof Error ? e.message : 'Failed to allow permissions');
    } finally {
      setBusy(null);
    }
  }, [permissions, onReply, onAutoApproveChange]);

  if (autoApprove) {
    return (
      <div data-testid="acp-session-permission-autoapprove" className="border-border/60 bg-muted/40 mb-2 flex items-center gap-2 rounded-xl border px-3 py-1.5">
        <ShieldCheck className="text-muted-foreground size-3.5" />
        <span className="text-muted-foreground flex-1 text-[11px]">
          Auto-allowing all permission requests for this session
        </span>
        <Button size="xs" variant="ghost" onClick={() => onAutoApproveChange(false)}>
          Turn off
        </Button>
      </div>
    );
  }

  if (permissions.length === 0) return null;

  return (
    <div data-testid="acp-session-permission-prompt" className="mb-2 overflow-hidden rounded-xl border border-amber-500/40 bg-amber-50/60 dark:bg-amber-950/20">
      <div className="flex items-center gap-2 border-amber-500/20 border-b px-3 py-1.5">
        <ShieldCheck className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-foreground text-xs font-semibold tracking-tight">
          {permissions.length === 1
            ? 'The agent needs your permission'
            : `${permissions.length} actions need your permission`}
        </span>
        <span className="text-muted-foreground text-[11px]">— it&apos;s paused until you decide</span>
      </div>
      <ul className="divide-amber-500/15 divide-y">
        {permissions.map((permission) => {
          const idKey = JSON.stringify(permission.id);
          const { allowOnce, allowSession, deny, extra } = resolvePermissionActionOptions(permission.options);
          const detail = permission.patterns.length ? permission.patterns.join('  ') : null;
          return (
            <li key={idKey} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground text-xs font-medium">{permissionLabel(permission)}</span>
                </div>
                {detail ? (
                  <code
                    title={detail}
                    className="text-muted-foreground mt-0.5 block truncate font-mono text-[11px]"
                  >
                    {detail}
                  </code>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                <Button
                  size="xs"
                  variant="muted"
                  className={cn('hover:bg-destructive/10 hover:text-destructive')}
                  disabled={!!busy}
                  onClick={() => void reply(permission, 'deny', deny)}
                >
                  {busy === `${idKey}:deny` ? <Loading className="size-3 animate-spin" /> : null}
                  Deny
                </Button>
                {allowSession ? (
                  <Button
                    size="xs"
                    variant="outline"
                    title="Allow this action for the rest of this session — the agent won't ask again for it"
                    disabled={!!busy}
                    onClick={() => void reply(permission, 'session', allowSession)}
                  >
                    {busy === `${idKey}:session` ? <Loading className="size-3 animate-spin" /> : null}
                    Allow for session
                  </Button>
                ) : null}
                {extra.map((option) => (
                  <Button
                    key={optionValue(option)}
                    size="xs"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void reply(permission, 'once', option)}
                  >
                    {option.label}
                  </Button>
                ))}
                <Button
                  size="xs"
                  variant="default"
                  data-testid="acp-permission-allow-once"
                  disabled={!!busy}
                  onClick={() => void reply(permission, 'once', allowOnce)}
                >
                  {busy === `${idKey}:once` ? <Loading className="size-3 animate-spin" /> : null}
                  Allow once
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-2 border-amber-500/15 border-t px-3 py-1.5">
        <span className="text-muted-foreground text-[11px]">This session:</span>
        <Button
          size="xs"
          variant="ghost"
          title="Allow every permission request for the rest of this session"
          disabled={!!busy}
          onClick={() => void allowAllForSession()}
        >
          {busy === 'session-all' ? <Loading className="size-3 animate-spin" /> : null}
          Allow everything
        </Button>
      </div>
    </div>
  );
}

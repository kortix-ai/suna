'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '@/components/ui/modal';
import { RadioGroup } from '@/components/ui/radio-group';

import { Skeleton } from '@/components/ui/skeleton';
import { successToast } from '@/components/ui/toast';
import { EntityAvatar } from '@/components/ui/entity-avatar';

import { ErrorState } from '@/features/layout/section/error-state';

import { ShareOption, SubjectPicker } from '@/features/workspace/shared/sharing-picker';

import { useTranslations } from '@/i18n/use-translations';

import { listAppAgents, type App, type AppAccessConfig, type AppAccessMode, type AppViewerTokenScope } from '@kortix/sdk';
import { useAppAccess } from '@kortix/sdk/react';
import { RobotIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';

import { useState } from 'react';

import { localizedAppCopy, ANONYMOUS_MODES } from './app-shared';

export function AppAccessModal({
  projectId,
  app,
  access,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  access: ReturnType<typeof useAppAccess>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Modal open={open} onOpenChange={(value) => !access.update.isPending && onOpenChange(value)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>{tI18nComplete.raw('text869903a43092')}</ModalTitle>
          <ModalDescription>
            {tI18nComplete.raw('text2395784386a5')} {app.name}
            {tI18nComplete.raw('text56000ae371ac')}
          </ModalDescription>
        </ModalHeader>
        {access.policy.isLoading ? (
          <ModalBody>
            <Skeleton className="h-48 w-full rounded-md" />
          </ModalBody>
        ) : access.policy.isError ? (
          <>
            <ModalBody>
              <ErrorState
                size="sm"
                title={tI18nComplete.raw('textac7f89823c42')}
                description={(access.policy.error as Error).message}
                action={
                  <Button size="sm" variant="outline" onClick={() => access.policy.refetch()}>
                    {tI18nComplete.raw('text942087cc2d41')}
                  </Button>
                }
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="outline-ghost" size="sm" onClick={() => onOpenChange(false)}>
                {tI18nComplete.raw('text7d9eb7acb13e')}
              </Button>
            </ModalFooter>
          </>
        ) : access.policy.data ? (
          <AppAccessForm
            key={access.policy.data.revision}
            projectId={projectId}
            appId={app.app_id}
            policy={access.policy.data}
            update={access.update}
            onSaved={() => onOpenChange(false)}
          />
        ) : null}
      </ModalContent>
    </Modal>
  );
}

function AppAccessForm({
  projectId,
  appId,
  policy,
  update,
  onSaved,
}: {
  projectId: string;
  appId: string;
  policy: AppAccessConfig;
  update: ReturnType<typeof useAppAccess>['update'];
  onSaved: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(tI18nComplete);
  const [mode, setMode] = useState<AppAccessMode>(policy.mode);
  const [memberIds, setMemberIds] = useState<string[]>(policy.member_ids);
  const [groupIds, setGroupIds] = useState<string[]>(policy.group_ids);
  const [password, setPassword] = useState('');
  const [viewerScope, setViewerScope] = useState<AppViewerTokenScope>(policy.viewer_token_scope);
  const incomplete = mode === 'restricted' && memberIds.length + groupIds.length === 0;
  const passwordMissing = mode === 'password' && !password && !policy.password_configured;
  // Public and password Apps are opened without signing in to Kortix, so there
  // is no viewer identity to share — the control goes away and the field stays
  // as it is on the server rather than being written to a meaningless value.
  const hasSignedInViewer = !ANONYMOUS_MODES.includes(mode);

  const save = async () => {
    try {
      await update.mutateAsync({
        mode,
        ...(mode === 'restricted' ? { member_ids: memberIds, group_ids: groupIds } : {}),
        ...(mode === 'password' && password ? { password } : {}),
        ...(hasSignedInViewer ? { viewer_token_scope: viewerScope } : {}),
      });
      successToast(tI18nComplete.raw('text0e76da589934'));
      onSaved();
    } catch {
      // The query client's global `mutations.onError` already toasts the failure.
      // A second toast here rendered the heading twice. The modal stays open.
    }
  };

  return (
    <>
      <ModalBody className="max-h-[65vh] space-y-4 overflow-y-auto">
        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as AppAccessMode)}
          className="space-y-2"
        >
          {(Object.keys(appCopy.access) as AppAccessMode[]).map((value) => (
            <ShareOption
              key={value}
              value={value}
              label={
                appCopy.access[value].label
              }
              desc={
                appCopy.access[value].desc
              }
            />
          ))}
        </RadioGroup>
        {mode === 'restricted' ? (
          <SubjectPicker
            projectId={projectId}
            memberIds={memberIds}
            groupIds={groupIds}
            onChange={(members, groups) => {
              setMemberIds(members);
              setGroupIds(groups);
            }}
          />
        ) : null}
        {mode === 'restricted' || mode === 'private' ? (
          <AppAgentsWithAccess projectId={projectId} appId={appId} />
        ) : null}
        {mode === 'password' ? (
          <div className="space-y-2">
            <Label htmlFor="app-access-password">
              {policy.password_configured
                ? tI18nComplete.raw('textd96a37fc02f0')
                : appCopy.access.password.label}
            </Label>
            <Input
              id="app-access-password"
              type="password"
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              placeholder={
                policy.password_configured
                  ? tI18nComplete.raw('text985a580ee200')
                  : tI18nComplete.raw('text977f3b2676a9')
              }
            />
          </div>
        ) : null}
        <div className="space-y-2">
          <Label id="app-viewer-identity-label">{tI18nComplete.raw('text5562d6d4c826')}</Label>
          {hasSignedInViewer ? (
            <RadioGroup
              aria-labelledby="app-viewer-identity-label"
              value={viewerScope}
              onValueChange={(value) => setViewerScope(value as AppViewerTokenScope)}
              className="space-y-2"
            >
              {(Object.keys(appCopy.viewerScope) as AppViewerTokenScope[]).map((value) => (
                <ShareOption
                  key={value}
                  value={value}
                  label={
                    appCopy.viewerScope[value].label
                  }
                  desc={
                    appCopy.viewerScope[value].desc
                  }
                />
              ))}
            </RadioGroup>
          ) : (
            <p className="text-muted-foreground text-xs">
              {mode === 'public'
                ? tI18nComplete.raw('textd3e9c765c2a3')
                : tI18nComplete.raw('text44332adbd9d2')}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter className="sm:justify-between">
        <Button variant="outline-ghost" size="sm" onClick={onSaved} disabled={update.isPending}>
          {tI18nComplete.raw('text19766ed6ccb2')}
        </Button>
        <Button
          size="sm"
          onClick={save}
          disabled={update.isPending || incomplete || passwordMissing}
        >
          {update.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {tI18nComplete.raw('text1509f561f241')}
        </Button>
      </ModalFooter>
    </>
  );
}

/**
 * The agents a restricted or private App admits besides the people above: every
 * agent whose `kortix.yaml` grant `agents.<name>.apps` names this App, or is
 * `all`. Read-only here — the manifest is the source of truth, so the list
 * changes through a change request, never through this dialog. The App gate
 * also requires `project.app.read` in the agent's effective permissions
 * (spec 2026-09-22 agents as principals §2.5).
 */
function AppAgentsWithAccess({ projectId, appId }: { projectId: string; appId: string }) {
  const t = useTranslations('agentPrincipals');
  const agentsQuery = useQuery({
    queryKey: ['app-agents', projectId, appId],
    queryFn: () => listAppAgents(projectId, appId),
    staleTime: 30_000,
    retry: false,
  });
  return (
    <div className="space-y-2" data-testid="app-agents-with-access">
      <Label>{t('appAgentsTitle')}</Label>
      {agentsQuery.isLoading ? (
        <Skeleton className="h-10 w-full rounded-md" />
      ) : agentsQuery.isError ? (
        <p className="text-muted-foreground text-xs">{(agentsQuery.error as Error).message}</p>
      ) : (agentsQuery.data ?? []).length === 0 ? (
        <p className="text-muted-foreground text-xs text-pretty">{t('appAgentsEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {(agentsQuery.data ?? []).map((agent) => (
            <li
              key={agent.agent_name}
              className="bg-popover flex items-center gap-2.5 rounded-md border px-3 py-2"
            >
              <EntityAvatar icon={RobotIcon} label={agent.agent_name} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm font-medium">{agent.agent_name}</p>
                <p className="text-muted-foreground truncate text-xs">
                  {t('appAgentsDeclared', {
                    file: agent.path.split('#')[0] ?? 'kortix.yaml',
                    agent: agent.agent_name,
                  })}
                </p>
              </div>
              <Badge variant="outline" size="sm">
                {agent.grant === 'all' ? t('appAgentsGrantAll') : t('agentBadge')}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

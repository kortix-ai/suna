'use client';

import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import {
  deleteProjectProviderOAuth,
  deleteProjectSecret,
  getProjectDetail,
  listProjectPersonalProviders,
  listUserProviderConnections,
  pollProjectProviderOAuth,
  pollUserProviderOAuth,
  saveUserProviderApiKey,
  setProjectPersonalProvider,
  startProjectProviderOAuth,
  startUserProviderOAuth,
  upsertProjectSecret,
} from '@kortix/sdk';
import { qk, refreshProjectProviderState } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type ComponentType, useEffect, useId, useRef, useState } from 'react';
import type { ProviderConnectRow, ProviderKeyFieldsProps } from './provider-connect';

const connectionsKey = ['user-provider-connections'];

/** The list shows status. Credential entry and ownership stay in one dialog. */
export function ProjectProviderConnection({
  projectId,
  row,
  canWrite,
  subscriptionConnected,
  projectConnectionsLoading,
  KeyFields,
}: {
  projectId: string;
  row: ProviderConnectRow;
  canWrite: boolean;
  subscriptionConnected: boolean;
  projectConnectionsLoading: boolean;
  KeyFields: ComponentType<ProviderKeyFieldsProps>;
}) {
  const t = useTranslations('personalProviders');
  const client = useQueryClient();
  const id = useId();
  const project = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
  });
  const personalEnabled = isLlmGatewayEnabled(project.data?.project);
  const connections = useQuery({
    queryKey: connectionsKey,
    queryFn: listUserProviderConnections,
    enabled: personalEnabled,
  });
  const bindings = useQuery({
    queryKey: [...connectionsKey, projectId],
    queryFn: () => listProjectPersonalProviders(projectId),
    enabled: personalEnabled,
  });
  const adapters = personalEnabled
    ? (connections.data?.providers.filter(
        (p) => p.provider_id === row.id || (row.id === 'openai' && p.provider_id === 'codex'),
      ) ?? [])
    : [];
  const active = adapters.find((p) =>
    bindings.data?.items.some((b) => b.provider_id === p.provider_id),
  );
  const isConnected = !!active || row.connected || subscriptionConnected;
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('personal');
  const [method, setMethod] = useState('api_key');
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [challenge, setChallenge] = useState<{ url: string; code: string | null } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const adapter = adapters.find((p) => p.auth_type === method);
  const personal = scope === 'personal';
  const stored = personal
    ? !!adapter && !!connections.data?.items.some((c) => c.provider_id === adapter.provider_id)
    : method === 'device_oauth'
      ? subscriptionConnected
      : row.connected;
  const hasValues = Object.values(values).some((v) => v.trim());
  const complete =
    row.envVars.length > 0 && row.envVars.every((env) => values[`${row.id}:${env}`]?.trim());
  const loadFailed =
    project.isError || (personalEnabled && (connections.isError || bindings.isError));
  const loading =
    projectConnectionsLoading ||
    project.isPending ||
    (personalEnabled && (connections.isPending || bindings.isPending));

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: connectionsKey }),
      client.invalidateQueries({ queryKey: qk.project.secrets(projectId) }),
    ]);
    refreshProjectProviderState(client, projectId);
  }
  async function selectConnection(providerId?: string) {
    // Keep the previous credential usable until the replacement is available.
    if (providerId) await setProjectPersonalProvider(projectId, providerId, true);
    for (const other of adapters) {
      if (
        other.provider_id !== providerId &&
        bindings.data?.items.some((b) => b.provider_id === other.provider_id)
      ) {
        await setProjectPersonalProvider(projectId, other.provider_id, false);
      }
    }
  }
  function resetDraft() {
    setValues({});
    setRevealed({});
    setChallenge(null);
    connect.reset();
  }
  function showDialog() {
    resetDraft();
    const nextScope = active
      ? 'personal'
      : row.connected || subscriptionConnected
        ? 'project'
        : adapters.length
          ? 'personal'
          : 'project';
    setScope(nextScope);
    setMethod(
      active?.auth_type ??
        (subscriptionConnected || (row.id === 'openai' && !row.connected)
          ? 'device_oauth'
          : 'api_key'),
    );
    setOpen(true);
  }
  function closeDialog() {
    generation.current++;
    setOpen(false);
    resetDraft();
  }
  const connect = useMutation({
    mutationFn: async ({ attempt, authorize }: { attempt: number; authorize?: boolean }) => {
      if (personal && !adapter) throw new Error(t('loadFailed'));
      if (method === 'api_key' && hasValues) {
        if (personal)
          await saveUserProviderApiKey(
            adapter!.provider_id,
            values[`${row.id}:${row.envVars[0]}`]!.trim(),
          );
        else {
          if (!canWrite) throw new Error(t('projectReadOnly'));
          await Promise.all(
            row.envVars.map((name) =>
              upsertProjectSecret(projectId, {
                name,
                value: values[`${row.id}:${name}`]!.trim(),
                strategy: 'broker',
                consumer: 'llm_gateway',
              }),
            ),
          );
        }
      } else if (method === 'device_oauth' && (!stored || authorize) && (personal || canWrite)) {
        if (!personal && !canWrite) throw new Error(t('projectReadOnly'));
        const start = personal
          ? await startUserProviderOAuth(adapter!.provider_id)
          : await startProjectProviderOAuth(projectId, 'openai', { sharing: { mode: 'project' } });
        if (generation.current !== attempt) return;
        setChallenge({ url: start.verification_url, code: start.user_code });
        let authorized = false;
        // eslint-disable-next-line react-hooks/purity -- Runs after the user submits, not during render.
        while (Date.now() < start.expires_at) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(3000, start.interval_ms)));
          if (generation.current !== attempt) return;
          const result = personal
            ? await pollUserProviderOAuth(adapter!.provider_id, start.flow_id)
            : await pollProjectProviderOAuth(projectId, 'openai', start.flow_id);
          if (generation.current !== attempt) return;
          if (result.status === 'success') {
            authorized = true;
            break;
          }
          if (result.status === 'failed') throw new Error(result.error);
          if (result.status === 'expired') break;
        }
        if (!authorized) throw new Error(t('expired'));
      }
      if (generation.current !== attempt) return;
      await selectConnection(personal ? adapter!.provider_id : undefined);
      await refresh();
      closeDialog();
    },
    onError: (_error, { attempt }) => {
      if (generation.current !== attempt) return;
      setChallenge(null);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (personal) await selectConnection();
      else if (method === 'device_oauth') await deleteProjectProviderOAuth(projectId, 'openai');
      else await Promise.all(row.envVars.map((name) => deleteProjectSecret(projectId, name)));
      await refresh();
      setConfirmRemove(false);
      closeDialog();
    },
  });
  const busy = connect.isPending || remove.isPending;
  const canSubmit =
    !busy &&
    !loadFailed &&
    (personal ? !!adapter : canWrite || !!active) &&
    (method === 'device_oauth' || (hasValues ? complete : stored || (!personal && !!active)));

  return (
    <div className="flex min-w-0 items-center justify-end gap-3">
      <span role="status" className="text-muted-foreground text-right text-xs">
        {loading ? (
          <Loading />
        ) : loadFailed ? (
          t('loadFailed')
        ) : active ? (
          t('connectedPersonal')
        ) : isConnected ? (
          t('connectedProject')
        ) : (
          t('notConnected')
        )}
      </span>
      <Button
        id={`provider-action-${row.id}`}
        variant="outline"
        size="sm"
        disabled={loading || loadFailed || (!canWrite && !adapters.length)}
        onClick={showDialog}
      >
        {isConnected ? t('manage') : t('connect')}
      </Button>
      <Modal
        open={open}
        onOpenChange={(next) => {
          if (!next && (!busy || challenge)) closeDialog();
        }}
      >
        <ModalContent className="lg:max-w-md" showCloseButton={!busy || !!challenge}>
          <ModalHeader>
            <ModalTitle>{t('connectionFor', { provider: row.label })}</ModalTitle>
          </ModalHeader>
          <ModalBody className="space-y-5">
            <fieldset disabled={busy} className="space-y-5">
              {row.id === 'openai' && (
                <div className="space-y-2">
                  <Label htmlFor={`${id}-method`}>{t('method')}</Label>
                  <Select
                    value={method}
                    onValueChange={(next) => {
                      setMethod(next);
                      resetDraft();
                    }}
                    disabled={busy}
                  >
                    <SelectTrigger id={`${id}-method`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="device_oauth">{t('subscriptionMethod')}</SelectItem>
                      <SelectItem value="api_key">{t('keyMethod')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              {adapters.length > 0 ? (
                <RadioGroup
                  value={scope}
                  onValueChange={(next) => {
                    setScope(next);
                    resetDraft();
                  }}
                  aria-label={t('ownership')}
                  disabled={busy}
                >
                  <Label className="flex items-center gap-2" htmlFor={`${id}-personal`}>
                    <RadioGroupItem id={`${id}-personal`} value="personal" />
                    {t('useMyAccount')}
                  </Label>
                  <Label className="flex items-center gap-2" htmlFor={`${id}-project`}>
                    <RadioGroupItem
                      id={`${id}-project`}
                      value="project"
                      disabled={!canWrite && !active}
                    />
                    {canWrite ? t('shareProject') : t('projectConnection')}
                  </Label>
                </RadioGroup>
              ) : null}
              <p className="text-muted-foreground text-xs">
                {personal ? t('privateHint') : canWrite ? t('sharedHint') : t('projectReadOnly')}
              </p>
              {method === 'api_key' && (personal || canWrite) && (
                <KeyFields
                  row={{ ...row, connected: stored }}
                  values={values}
                  onValueChange={(_provider, env, value) =>
                    setValues((current) => ({ ...current, [`${row.id}:${env}`]: value }))
                  }
                  onCommit={() => {}}
                  status="idle"
                  revealedFields={revealed}
                  onToggleReveal={(_provider, env) =>
                    setRevealed((current) => ({
                      ...current,
                      [`${row.id}:${env}`]: !current[`${row.id}:${env}`],
                    }))
                  }
                />
              )}
              {stored && (
                <p className="text-muted-foreground text-xs">
                  {personal ? t('reuseHint') : t('projectSavedHint')}
                </p>
              )}
            </fieldset>
            {challenge && <ChatGptDeviceChallenge {...challenge} />}
            {connect.isError && <InfoBanner tone="destructive">{connect.error.message}</InfoBanner>}
            {remove.isError && <InfoBanner tone="destructive">{remove.error.message}</InfoBanner>}
            {stored && method === 'device_oauth' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || (!personal && !canWrite)}
                onClick={() => connect.mutate({ attempt: ++generation.current, authorize: true })}
              >
                {t('reconnectChatGpt')}
              </Button>
            )}
            {(personal
              ? !!active && active.provider_id === adapter?.provider_id
              : stored && canWrite) && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  remove.reset();
                  setConfirmRemove(true);
                }}
              >
                {personal ? t('stopUsing') : t('removeProject')}
              </Button>
            )}
          </ModalBody>
          <ModalFooter>
            <Button variant="outline" disabled={busy && !challenge} onClick={closeDialog}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!canSubmit}
              aria-busy={busy}
              aria-label={busy ? t('connect') : undefined}
              onClick={() => connect.mutate({ attempt: ++generation.current })}
            >
              {busy ? (
                <Loading />
              ) : hasValues ? (
                t('saveConnection')
              ) : stored ? (
                personal ? (
                  t('useAccount')
                ) : (
                  t('useProject')
                )
              ) : !personal && !canWrite && active ? (
                t('useProject')
              ) : method === 'device_oauth' ? (
                t('connectChatGpt')
              ) : !personal && active ? (
                t('useProject')
              ) : (
                t('connect')
              )}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={personal ? t('stopUsing') : t('removeProject')}
        description={
          <div className="space-y-2">
            <p>{personal ? t('stopUsingHint') : t('removeProjectHint')}</p>
            {remove.isError && <InfoBanner tone="destructive">{remove.error.message}</InfoBanner>}
          </div>
        }
        confirmLabel={t('disconnect')}
        cancelLabel={t('cancel')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

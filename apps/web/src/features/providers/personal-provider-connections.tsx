'use client';

import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  deleteUserProviderConnection,
  listUserProviderConnections,
  pollUserProviderOAuth,
  saveUserProviderApiKey,
  startUserProviderOAuth,
} from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

const connectionsKey = ['user-provider-connections'];

/** Account settings manage reusable credentials. Project provider rows select their scope. */
export function PersonalProviderConnections() {
  const t = useTranslations('personalProviders');
  const queryClient = useQueryClient();
  const connections = useQuery({ queryKey: connectionsKey, queryFn: listUserProviderConnections });
  const [provider, setProvider] = useState('codex');
  const [apiKey, setApiKey] = useState('');
  const [remove, setRemove] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ url: string; code: string | null } | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const adapter = connections.data?.providers.find((p) => p.provider_id === provider);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: connectionsKey });
    void queryClient.invalidateQueries();
  };
  const connect = useMutation({
    mutationFn: async () => {
      const attempt = ++generation.current;
      if (adapter?.auth_type === 'api_key') {
        await saveUserProviderApiKey(provider, apiKey);
        setApiKey('');
      } else {
        const start = await startUserProviderOAuth(provider);
        if (generation.current !== attempt) return;
        setChallenge({ url: start.verification_url, code: start.user_code });
        let authorized = false;
        while (Date.now() < start.expires_at) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(3000, start.interval_ms)));
          if (generation.current !== attempt) return;
          const result = await pollUserProviderOAuth(provider, start.flow_id);
          if (generation.current !== attempt) return;
          if (result.status === 'success') {
            authorized = true;
            break;
          }
          if (result.status === 'failed') throw new Error(result.error);
          if (result.status === 'expired') throw new Error(t('expired'));
          if (Date.now() >= start.expires_at) throw new Error(t('expired'));
        }
        if (!authorized) throw new Error(t('expired'));
      }
      if (generation.current !== attempt) return;
      setChallenge(null);
      await refresh();
      successToast(t('connected'));
    },
    onError: (error) => {
      setChallenge(null);
      errorToast(error.message);
    },
  });
  const disconnect = useMutation({
    mutationFn: deleteUserProviderConnection,
    onSuccess: async () => {
      setRemove(null);
      await refresh();
    },
    onError: (error) => errorToast(error.message),
  });

  if (connections.isPending) return <Loading />;
  if (connections.isError)
    return <InfoBanner tone="destructive">{connections.error.message}</InfoBanner>;
  const providers = connections.data.providers;
  return (
    <section className="space-y-4" aria-label={t('region')}>
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium">{t('title')}</h3>
        <p className="text-muted-foreground text-xs">
          {t('description')} {t('globalDescription')}
        </p>
      </div>
      {connections.data.items.length > 0 && (
        <ul className="bg-popover divide-y rounded-md border">
          {connections.data.items.map((connection) => {
            const id = connection.provider_id;
            const name = providers.find((p) => p.provider_id === id)?.name ?? id;
            return (
              <li key={id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{name}</p>
                  <p className="text-muted-foreground text-xs">
                    {connection.auth_type === 'api_key'
                      ? t('personalApiKey')
                      : t('personalSubscription')}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setRemove(id)}>
                  {t('disconnect')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="space-y-4">
        <Field>
          <FieldLabel htmlFor="personal-provider">{t('provider')}</FieldLabel>
          <Select value={provider} onValueChange={setProvider} disabled={connect.isPending}>
            <SelectTrigger id="personal-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providers.map((p) => (
                <SelectItem key={p.provider_id} value={p.provider_id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {adapter?.auth_type === 'api_key' && (
          <Field>
            <FieldLabel htmlFor="personal-provider-key">{t('apiKey')}</FieldLabel>
            <Input
              id="personal-provider-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={connect.isPending}
            />
          </Field>
        )}
        {challenge && <ChatGptDeviceChallenge {...challenge} />}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={
              connect.isPending || !adapter || (adapter.auth_type === 'api_key' && !apiKey.trim())
            }
            onClick={() => connect.mutate()}
          >
            {connect.isPending && <Loading className="size-4" />}
            {adapter?.auth_type === 'device_oauth' ? t('connectChatGpt') : t('saveKey')}
          </Button>
          {challenge && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                generation.current++;
                setChallenge(null);
              }}
            >
              {t('cancel')}
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open) setRemove(null);
        }}
        title={t('disconnectTitle')}
        description={t('disconnectDescription')}
        confirmLabel={t('disconnect')}
        confirmVariant="destructive"
        isPending={disconnect.isPending}
        onConfirm={() => {
          if (remove) disconnect.mutate(remove);
        }}
      />
    </section>
  );
}

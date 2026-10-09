'use client';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast } from '@/components/ui/toast';
import { ManifestCopyBlock } from '@/features/workspace/customize/sections/component/manifest-copy-block';
import { useTranslations } from '@/i18n/use-translations';
import {
  APP_CONNECT_TABS,
  type AppConnectSnippet,
  type AppConnectSnippetId,
  type AppConnectTab,
  appConnectSnippets,
} from '@kortix/shared/app-connect';
import { getAppCredentials, type App } from '@kortix/sdk';
import { useState } from 'react';

const LANGUAGE: Record<AppConnectSnippet['language'], string> = {
  ts: 'typescript',
  sh: 'bash',
  dotenv: 'bash',
};

/** The revealed admin credentials as `.env.local` lines for the client CLI. */
export function credentialsEnvText(env: Record<string, string>): string {
  return [
    `CONVEX_SELF_HOSTED_URL=${env.CONVEX_SELF_HOSTED_URL ?? ''}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? ''}`,
  ].join('\n');
}

/**
 * How to reach an App that serves an API (capability `admin_credentials`):
 * from another App, from outside, from the CLI. The snippets come from
 * `@kortix/shared/app-connect`, the same source `kortix apps connect` prints;
 * the App's capabilities choose the tabs. The admin key appears only after an
 * explicit Reveal, which reads the audited credentials route; closing the
 * dialog drops it.
 */
export function AppConnectDialog({
  projectId,
  app,
  canAdmin,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canAdmin: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [tab, setTab] = useState<AppConnectTab>('app');
  const snippets = appConnectSnippets(app);
  const tabs = APP_CONNECT_TABS.filter((id) => snippets.some((snippet) => snippet.tab === id));

  const tabLabels: Record<AppConnectTab, { label: string; description: string }> = {
    app: { label: t.raw('text0d04bfeb7d64'), description: t.raw('textd5f5bd67e572') },
    outside: { label: t.raw('text532c119fcb6b'), description: t.raw('text7364258e238a') },
    admin: { label: t.raw('text5ef3580e4f2e'), description: t.raw('textdbbe76672da2') },
  };
  const titles: Record<AppConnectSnippetId, string> = {
    'app-install': t.raw('text7fcc818eb01f'),
    'app-uses': t.raw('textfa81dc800785'),
    'app-client': t.raw('text6851f4ca258c'),
    'server-auth-config': t.raw('text79a6c5c5b965'),
    'server-function': t.raw('text8ef95f8fdadb'),
    'outside-token-cli': t.raw('textbcfb13cc6799'),
    'outside-token-sdk': t.raw('text402c230e740b'),
    'outside-query': t.raw('textfb195abf4173'),
    'outside-mutation': t.raw('text781613a81056'),
    'outside-http-action': t.raw('text28fa7e7a8a16'),
    'outside-verify': t.raw('text8034c809dd46'),
    'outside-verify-env': t.raw('text6d82b9d57b0c'),
    'admin-cli': t.raw('text00739f5cd92d'),
  };

  return (
    <Modal open onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>{t('text484cb2c544a7', { value0: app.name })}</ModalTitle>
          <ModalDescription>{tabLabels[tab].description}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Tabs value={tab} onValueChange={(value) => setTab(value as AppConnectTab)}>
            <TabsList>
              {tabs.map((id) => (
                <TabsTrigger key={id} value={id}>
                  {tabLabels[id].label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tabs.map((id) => (
              <TabsContent key={id} value={id} className="mt-4 space-y-4" data-testid={`app-connect-${id}`}>
                {snippets
                  .filter((snippet) => snippet.tab === id)
                  .map((snippet) => (
                    <section key={snippet.id} className="space-y-1.5">
                      <p className="text-muted-foreground text-xs">{titles[snippet.id]}</p>
                      <ManifestCopyBlock
                        text={snippet.code}
                        filename={snippet.file}
                        language={LANGUAGE[snippet.language]}
                      />
                    </section>
                  ))}
                {id === 'admin' ? (
                  <AdminKey projectId={projectId} app={app} canAdmin={canAdmin} />
                ) : null}
              </TabsContent>
            ))}
          </Tabs>
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.raw('text7d9eb7acb13e')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** The admin key, behind an explicit Reveal. Each reveal is one audited `app.credentials.read`. */
function AdminKey({
  projectId,
  app,
  canAdmin,
}: {
  projectId: string;
  app: App;
  canAdmin: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);

  const reveal = async () => {
    setLoading(true);
    try {
      setEnv((await getAppCredentials(projectId, app.app_id)).env);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t.raw('text9962d69a4916'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-1.5" data-testid="app-admin-key">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{t.raw('textb046e155c93a')}</Label>
          <p className="text-muted-foreground text-xs">
            {canAdmin ? t.raw('text41fa1daf731c') : t.raw('text53cd6fcaa9d6')}
          </p>
        </div>
        {canAdmin ? (
          env ? (
            <Button size="sm" variant="outline" onClick={() => setEnv(null)}>
              {t.raw('textac20a57bfde0')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={loading || app.instance?.status !== 'running'}
              onClick={() => void reveal()}
            >
              {loading ? <Loading className="size-4 shrink-0" /> : null}
              {t.raw('text36b830bdb447')}
            </Button>
          )
        ) : null}
      </div>
      {env ? <ManifestCopyBlock text={credentialsEnvText(env)} filename=".env.local" language="bash" /> : null}
    </section>
  );
}

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
  BACKEND_CONNECT_TABS,
  type BackendConnectSnippet,
  type BackendConnectSnippetId,
  type BackendConnectTab,
  backendConnectSnippets,
} from '@kortix/shared/backend-connect';
import { getBackendCredentials, type ProjectBackend } from '@kortix/sdk';
import { useState } from 'react';

const LANGUAGE: Record<BackendConnectSnippet['language'], string> = {
  ts: 'typescript',
  sh: 'bash',
  dotenv: 'bash',
};

/** The revealed admin credentials as `.env.local` lines for the Convex CLI. */
export function backendEnvText(env: Record<string, string>): string {
  return [
    `CONVEX_SELF_HOSTED_URL=${env.CONVEX_SELF_HOSTED_URL ?? ''}`,
    `CONVEX_SELF_HOSTED_ADMIN_KEY=${env.CONVEX_SELF_HOSTED_ADMIN_KEY ?? ''}`,
  ].join('\n');
}

/**
 * How to reach one backend: from an App, from outside, from the CLI. The
 * snippets come from `@kortix/shared/backend-connect`, the same source as
 * `kortix backends connect`. The admin key appears only after an explicit
 * Reveal, which reads the audited credentials route; closing the dialog drops it.
 */
export function BackendConnectDialog({
  projectId,
  backend,
  canWrite,
  onOpenChange,
}: {
  projectId: string;
  backend: ProjectBackend;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [tab, setTab] = useState<BackendConnectTab>('app');
  const snippets = backendConnectSnippets(backend);

  const tabLabels: Record<BackendConnectTab, { label: string; description: string }> = {
    app: { label: t.raw('text0d04bfeb7d64'), description: t.raw('text191cb68cd2a8') },
    outside: { label: t.raw('text532c119fcb6b'), description: t.raw('text7364258e238a') },
    admin: { label: t.raw('text5ef3580e4f2e'), description: t.raw('textdbbe76672da2') },
  };
  const titles: Record<BackendConnectSnippetId, string> = {
    'app-install': t.raw('text294cc628974b'),
    'app-backends': t.raw('text1af77a9ae95c'),
    'app-env': t.raw('text411987e899ae'),
    'app-client': t.raw('text7aa71e6b61dd'),
    'backend-auth-config': t.raw('texta064b3f41933'),
    'backend-function': t.raw('text8ef95f8fdadb'),
    'outside-token-cli': t.raw('text5c32a2ca9cf6'),
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
          <ModalTitle>{t('text484cb2c544a7', { value0: backend.name })}</ModalTitle>
          <ModalDescription>{tabLabels[tab].description}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Tabs value={tab} onValueChange={(value) => setTab(value as BackendConnectTab)}>
            <TabsList>
              {BACKEND_CONNECT_TABS.map((id) => (
                <TabsTrigger key={id} value={id}>
                  {tabLabels[id].label}
                </TabsTrigger>
              ))}
            </TabsList>
            {BACKEND_CONNECT_TABS.map((id) => (
              <TabsContent key={id} value={id} className="mt-4 space-y-4" data-testid={`backend-connect-${id}`}>
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
                  <AdminKey projectId={projectId} backend={backend} canWrite={canWrite} />
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

/** The admin key, behind an explicit Reveal. Each reveal is one audited `backend.credentials.read`. */
function AdminKey({
  projectId,
  backend,
  canWrite,
}: {
  projectId: string;
  backend: ProjectBackend;
  canWrite: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);

  const reveal = async () => {
    setLoading(true);
    try {
      setEnv((await getBackendCredentials(projectId, backend.backend_id)).env);
    } catch (error) {
      errorToast(error instanceof Error ? error.message : t.raw('text9962d69a4916'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="space-y-1.5" data-testid="backend-admin-key">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <Label>{t.raw('textb046e155c93a')}</Label>
          <p className="text-muted-foreground text-xs">
            {canWrite
              ? t.raw('text41fa1daf731c')
              : t.raw('text9a279a66b44a')}
          </p>
        </div>
        {canWrite ? (
          env ? (
            <Button size="sm" variant="outline" onClick={() => setEnv(null)}>
              {t.raw('textac20a57bfde0')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={loading || backend.status !== 'running'}
              onClick={() => void reveal()}
            >
              {loading ? <Loading className="size-4 shrink-0" /> : null}
              {t.raw('text36b830bdb447')}
            </Button>
          )
        ) : null}
      </div>
      {env ? <ManifestCopyBlock text={backendEnvText(env)} filename=".env.local" language="bash" /> : null}
    </section>
  );
}

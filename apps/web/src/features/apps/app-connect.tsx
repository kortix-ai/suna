'use client';

import { Button } from '@/components/ui/button';
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
import { ManifestCopyBlock } from '@/features/workspace/customize/sections/component/manifest-copy-block';
import { useTranslations } from '@/i18n/use-translations';
import {
  APP_CONNECT_TABS,
  type AppConnectSnippet,
  type AppConnectSnippetId,
  type AppConnectTab,
  appConnectSnippets,
} from '@kortix/shared/app-connect';
import type { App } from '@kortix/sdk';
import { useState } from 'react';

const LANGUAGE: Record<AppConnectSnippet['language'], string> = {
  ts: 'typescript',
  sh: 'bash',
  dotenv: 'bash',
};

/**
 * How to reach an App from code: from another App, and from outside. The
 * snippets come from `@kortix/shared/app-connect`, the same source
 * `kortix apps connect` prints; the App's capabilities choose the tabs.
 */
export function AppConnectDialog({
  app,
  onOpenChange,
}: {
  app: App;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const [tab, setTab] = useState<AppConnectTab>('app');
  const snippets = appConnectSnippets(app);
  const tabs = APP_CONNECT_TABS.filter((id) => snippets.some((snippet) => snippet.tab === id));

  const tabLabels: Record<AppConnectTab, { label: string; description: string }> = {
    app: { label: t.raw('text0d04bfeb7d64'), description: t.raw('textd5f5bd67e572') },
    outside: { label: t.raw('text532c119fcb6b'), description: t.raw('text022ba4cb6981') },
  };
  const titles: Record<AppConnectSnippetId, string> = {
    'app-uses': t.raw('textfa81dc800785'),
    'app-client': t.raw('text6851f4ca258c'),
    'server-verify': t.raw('textdad6d4c4e992'),
    'outside-token-cli': t.raw('textbcfb13cc6799'),
    'outside-token-sdk': t.raw('text402c230e740b'),
    'outside-request': t.raw('text959f67f7ce9c'),
    'outside-verify': t.raw('text8034c809dd46'),
    'outside-verify-env': t.raw('text6d82b9d57b0c'),
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

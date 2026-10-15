'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { Button } from '@/components/ui/button';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Copy } from '@/features/icon/icons/copy';
import { useCopy } from '@/hooks/use-copy';
import { useTranslations } from '@/i18n/use-translations';
import {
  APP_CONNECT_TABS,
  type AppConnectSnippet,
  type AppConnectSnippetId,
  type AppConnectTab,
  appConnectSnippets,
} from '@kortix/shared/app-connect';
import type { App } from '@kortix/sdk';
import { CheckIcon as Check } from '@phosphor-icons/react';
import { useState } from 'react';

const LANGUAGE: Record<AppConnectSnippet['language'], string> = {
  ts: 'typescript',
  sh: 'bash',
  dotenv: 'bash',
};

/** One fenced block. A fence longer than any backtick run in the code keeps it closed. */
export function snippetFence(snippet: Pick<AppConnectSnippet, 'code' | 'language'>): string {
  const longest = Math.max(2, ...(snippet.code.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${LANGUAGE[snippet.language]}\n${snippet.code}\n${fence}`;
}

/**
 * The whole tab as one prompt: what to do, then every step with its file and
 * its code. Pasted into an agent, it carries the same instructions the dialog
 * shows a person.
 */
export function connectPrompt(
  heading: string,
  intro: string,
  steps: { title: string; snippet: AppConnectSnippet }[],
): string {
  return [
    `# ${heading}`,
    intro,
    ...steps.map(({ title, snippet }) => `## ${title}\n\nFile: \`${snippet.file}\`\n\n${snippetFence(snippet)}`),
  ].join('\n\n');
}

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

  const heading = t('text484cb2c544a7', { value0: app.name });
  const { copied, copy } = useCopy({ successMessage: t.raw('text42cc4740d3d5') });
  const steps = (id: AppConnectTab) =>
    snippets
      .filter((snippet) => snippet.tab === id)
      .map((snippet) => ({ title: titles[snippet.id], snippet }));

  return (
    <Modal open onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-2xl">
        <ModalHeader>
          <ModalTitle>{heading}</ModalTitle>
          <ModalDescription>{tabLabels[tab].description}</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <Tabs value={tab} onValueChange={(value) => setTab(value as AppConnectTab)}>
            {/* The tabs choose WHERE you connect from; the prompt button copies
                whichever one is showing, so it sits on the same row. */}
            <div className="flex items-center justify-between gap-3">
              <TabsList>
                {tabs.map((id) => (
                  <TabsTrigger key={id} value={id}>
                    {tabLabels[id].label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="shrink-0"
                onClick={() => void copy(connectPrompt(heading, tabLabels[tab].description, steps(tab)))}
                data-testid="app-connect-copy-prompt"
              >
                {copied ? <Check className="text-kortix-green size-3.5" /> : <Copy className="size-3.5" />}
                {t.raw('text5e1c0a7b2f4d')}
              </Button>
            </div>
            {tabs.map((id) => (
              <TabsContent key={id} value={id} className="mt-5 space-y-5" data-testid={`app-connect-${id}`}>
                {steps(id).map(({ title, snippet }, index) => (
                  <section key={snippet.id} className="space-y-2">
                    {/* Step, then the file it lands in. The code block owns
                        its own language label and copy control. */}
                    <div className="flex items-baseline gap-2">
                      <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">{index + 1}</span>
                      <p className="text-foreground min-w-0 flex-1 text-sm">{title}</p>
                      <code className="text-muted-foreground shrink-0 font-mono text-xs">{snippet.file}</code>
                    </div>
                    <UnifiedMarkdown content={snippetFence(snippet)} trust="trusted" />
                  </section>
                ))}
              </TabsContent>
            ))}
          </Tabs>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

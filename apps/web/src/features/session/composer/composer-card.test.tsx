/**
 * Pins the moved card subtrees no other suite renders, after KRTX-373
 * phase 1 split the composer's render tree out of `composer.tsx` into
 * `ComposerCard.tsx`: the drag overlay and the card's dimming class
 * (`isDragOver`), the `/` command + attachments refusal alert, and the
 * hidden file input that carries the attach `<input>` today.
 *
 * The already-extracted pieces the card composes (tiles, toolbar, underbar)
 * have their own suites. These assertions are on the RENDERED MARKUP, with
 * the same `renderToStaticMarkup` shell `composer-underbar.test.tsx` uses.
 */
import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/features/providers/auth-provider';
import { ComposerCard } from './ComposerCard';

const noop = () => {};
const asyncNoop = async () => {};

const messages = {
  hardcodedUi: {
    i18nComplete: { text1ab1b095c1ed: 'Drop files to attach' },
  },
};

/** Every prop the moved JSX reads; the values are inert test fixtures. */
function render(props?: {
  isDragOver?: boolean;
  commandAttachmentPlan?: { kind: 'refuse'; message: string; description: string };
  attachedFiles?: unknown[];
}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} onError={noop}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <AuthProvider>
          <TooltipProvider>
            <ComposerCard
              tHardcodedUi={
                {
                  raw: (key: string) =>
                    key === 'i18nComplete.text1ab1b095c1ed' ? 'Drop files to attach' : key,
                } as never
              }
              isDragOver={props?.isDragOver ?? false}
              handleDragEnter={noop}
              handleDragOver={noop}
              handleDragLeave={noop}
              handleDropFiles={noop}
              attachedFiles={(props?.attachedFiles ?? []) as never}
              promptAttachmentItems={[] as never}
              removeAttachedFile={noop}
              retryAttachedFile={noop}
              pastes={[]}
              removePaste={noop}
              commandAttachmentPlan={
                (props?.commandAttachmentPlan ?? { kind: 'carry', command: null }) as never
              }
              editorDisabled={false}
              editorRef={{ current: null } as never}
              setEditorRef={noop}
              editorPlaceholder="Ask anything…"
              animatePlaceholder={false}
              handleSubmit={asyncNoop}
              handleArrowUpAtStart={() => false}
              setIsEmpty={noop}
              handleDocChange={noop}
              allSessions={undefined}
              slashActions={[] as never}
              handleSelectAction={noop}
              dockId="composer-slash-dock-test"
              setMenuOpen={noop}
              fileInputRef={{ current: null } as never}
              handleFileSelect={noop}
              handleAttachClick={noop}
              primaryAgents={[] as never}
              availableSelectedModel={null}
              modelMenuOpen={false}
              setModelMenuOpen={noop}
              reasoningMenuOpen={false}
              setReasoningMenuOpen={noop}
              isEmpty
              canSubmit={false}
              submitDisabled={false}
              attachmentFailed={false}
              modelRejectingImages={null}
              imagesUnsupportedReason={null}
              modelUnavailable={false}
              agentUnavailable={false}
              noModelsConnected={false}
              sessionId="ses_test"
              onSend={asyncNoop}
              agents={[] as never}
              commands={[] as never}
              slashFiles={[] as never}
              models={[] as never}
              modelsLoading={false}
              modelRequired={false}
              variants={[] as never}
              messages={[] as never}
            />
          </TooltipProvider>
        </AuthProvider>
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('ComposerCard (the moved card subtrees)', () => {
  test('a drag-over card shows the named-action overlay and dims its content', () => {
    const html = render({ isDragOver: true });
    expect(html).toContain('pointer-events-none absolute inset-0');
    expect(html).toContain('Drop files to attach');
    expect(html).toContain('opacity-30');
    expect(html).toContain('border-kortix-blue/80');
  });

  test('without a drag, the overlay is absent and the card paints normally', () => {
    const html = render();
    expect(html).not.toContain('pointer-events-none absolute inset-0');
    expect(html).not.toContain('opacity-30');
  });

  test('the `/` command refusal renders a role=alert naming the conflict', () => {
    const html = render({
      commandAttachmentPlan: {
        kind: 'refuse',
        message: 'A /command cannot carry attachments',
        description: 'Detach the files or send without the command.',
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('A /command cannot carry attachments');
    expect(html).toContain('Detach the files or send without the command.');
  });

  test('the hidden multi-file input keeps its accept list (the attach path)', () => {
    const html = render();
    expect(html).toContain('type="file"');
    expect(html).toContain('multiple');
    expect(html).toContain('accept="image/*');
  });
});

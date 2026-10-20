'use client';

/**
 * The thread's panel intents on a page with no side panel.
 *
 * `SessionWorkspace` renders the side panel, and every "open in the panel"
 * action in the thread (a tool row's Preview, a file chip, a clickable path,
 * the header's Terminal, Browser, Files and Audit) opens there. A host that
 * renders `SessionThread` alone has no panel. `SessionThread` mounts this
 * component, so the same actions open an overlay instead of doing nothing:
 *
 * - a file opens in the file preview dialog (`FilePreviewHost`);
 * - Browser, Terminal, Files and Audit open in a modal with the panel's own view.
 *
 * It renders nothing while a side panel is mounted. See `panel-fallback-store.ts`.
 */

import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { lazy, Suspense, useEffect, type ReactNode } from 'react';

import { FilePreviewHost } from '../../files/file-preview-host';
import { useTranslations } from '../../i18n';
import {
  closePanelFallbackView,
  registerPanelFallbackHost,
  usePanelFallbackStore,
} from '../../internal/stores/panel-fallback-store';
import { useSessionBrowserStore } from '../../internal/stores/session-browser-store';
import Loading from '../../primitives/loading';
import { Modal, ModalContent, ModalTitle } from '../../primitives/modal';

const AppPreview = lazy(() => import('./easy/app-preview').then((m) => ({ default: m.AppPreview })));
const SessionTerminalPanel = lazy(() =>
  import('../../terminal/session-terminal-panel').then((m) => ({ default: m.SessionTerminalPanel })),
);
const SessionFilesExplorer = lazy(() =>
  import('./session-files-explorer').then((m) => ({ default: m.SessionFilesExplorer })),
);
const SessionAuditPanel = lazy(() =>
  import('./session-audit-panel').then((m) => ({ default: m.SessionAuditPanel })),
);

export interface SessionPanelFallbackProps {
  projectId: string;
  /** The Kortix session id (`useSession(...).sessionId`). */
  projectSessionId: string;
  /** The runtime session id (`useSession(...).runtimeSessionId`). Null while the runtime starts. */
  runtimeSessionId: string | null;
}

export function SessionPanelFallback({
  projectId,
  projectSessionId,
  runtimeSessionId,
}: SessionPanelFallbackProps) {
  useEffect(() => registerPanelFallbackHost(), []);
  const panelMounted = useSessionBrowserStore((s) => s.activeSessionId !== null);
  if (panelMounted) return null;
  return (
    <>
      <FilePreviewHost />
      <PanelViewModal
        projectId={projectId}
        projectSessionId={projectSessionId}
        runtimeSessionId={runtimeSessionId}
      />
    </>
  );
}

function PanelViewModal({ projectId, projectSessionId, runtimeSessionId }: SessionPanelFallbackProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const request = usePanelFallbackStore((s) => s.request);
  if (!request) return null;
  const { view, target } = request;
  const title =
    view === 'browser'
      ? target?.title || tI18nComplete.raw('text6026c1d8c92e')
      : view === 'terminal'
        ? 'Terminal'
        : view === 'audit'
          ? tI18nComplete.raw('textbb6aea287396')
          : target?.changes
            ? 'Changes'
            : 'Files';

  const body =
    view === 'browser' ? (
      <AppPreview
        url={target?.url ?? ''}
        name={title}
        projectId={projectId}
        shareContext={{ projectId, sessionId: projectSessionId }}
        onClose={closePanelFallbackView}
      />
    ) : view === 'audit' ? (
      <SessionAuditPanel projectId={projectId} projectSessionId={projectSessionId} />
    ) : !runtimeSessionId ? (
      <Centered>
        <Loading className="size-5" />
      </Centered>
    ) : view === 'terminal' ? (
      <SessionTerminalPanel
        sessionId={runtimeSessionId}
        projectId={projectId}
        projectSessionId={projectSessionId}
      />
    ) : (
      <SessionFilesExplorer
        chatSessionId={runtimeSessionId}
        projectId={projectId}
        projectSessionId={projectSessionId}
        ephemeral
        initialMode={target?.changes ? 'changes' : 'files'}
      />
    );

  return (
    <Modal open onOpenChange={(open) => !open && closePanelFallbackView()}>
      <ModalContent
        // The browser has its own close button in its toolbar.
        showCloseButton={view !== 'browser'}
        // A single full-bleed pane: no stacked header/body/footer spacing.
        className="flex h-[85vh] flex-col gap-0 space-y-0 overflow-hidden p-0 lg:max-h-[85vh] lg:max-w-5xl"
        data-slot="session-panel-fallback"
      >
        <VisuallyHidden>
          <ModalTitle>{title}</ModalTitle>
        </VisuallyHidden>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <Suspense
            fallback={
              <Centered>
                <Loading className="size-5" />
              </Centered>
            }
          >
            {body}
          </Suspense>
        </div>
      </ModalContent>
    </Modal>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="text-muted-foreground flex h-full items-center justify-center">{children}</div>;
}

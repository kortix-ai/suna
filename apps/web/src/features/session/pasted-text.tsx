'use client';

import { CopyButton } from '@/components/markdown/copy-button';
import { InlineMeta } from '@/components/ui/inline-meta';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { useTranslations } from '@/i18n/use-translations';

/**
 * A paste's full text, in the side panel's detail view or `PastedTextModal`.
 * Its one action, Copy, sits in the header (`PastedTextCopy`): the text is
 * already in the chat, so there is nothing to download or add.
 */
export function PastedTextBody({ text }: { text: string }) {
  return (
    <pre className="bg-popover text-foreground rounded-md border px-4 py-3 font-mono text-xs break-words whitespace-pre-wrap select-text">
      {text}
    </pre>
  );
}

export function PastedTextCopy({ text }: { text: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return <CopyButton code={text} size="sm" label={t.raw('texte21f935f11d7')} />;
}

/** Word and character counts for the header. Characters are what the user sees: graphemes, else code points. */
export function pastedTextCounts(text: string) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  let chars = 0;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    for (const _segment of new Intl.Segmenter().segment(text)) chars++;
  } else chars = Array.from(text).length;
  return { words, chars };
}

/** "72 words · 449 characters", the header meta of the panel and the modal. */
export function PastedTextMeta({ text }: { text: string }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const { words, chars } = pastedTextCounts(text);
  return (
    <InlineMeta>
      <span>{t('text23d0bb29fca0', { count: words })}</span>
      <span>{t('text426699d5a8c0', { count: chars })}</span>
    </InlineMeta>
  );
}

/** The side panel's paste view, as a modal, for hosts with no side panel (project home). */
export function PastedTextModal({ text, onClose }: { text: string | null; onClose: () => void }) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Modal open={text !== null} onOpenChange={(open) => !open && onClose()}>
      <ModalContent
        // Only the body scrolls: the header, Copy and Close (absolute in the
        // content box) stay in view on a long paste.
        className="flex flex-col overflow-hidden lg:h-auto lg:max-h-[85svh] lg:max-w-2xl"
        closeButtonChildren={text !== null ? <PastedTextCopy text={text} /> : null}
        // Opening focus would land on Copy and open its tooltip, so the first
        // Esc only closed the tooltip. Keep focus off the controls: one Esc closes.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <ModalHeader className="pr-20">
          <ModalTitle>{t.raw('text39cfc32bd12c')}</ModalTitle>
          <ModalDescription asChild>
            <div>{text !== null && <PastedTextMeta text={text} />}</div>
          </ModalDescription>
        </ModalHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {text !== null && <PastedTextBody text={text} />}
        </div>
      </ModalContent>
    </Modal>
  );
}

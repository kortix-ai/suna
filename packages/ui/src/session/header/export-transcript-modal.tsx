'use client';

import { useTranslations } from '../../i18n';

import { Button } from '../../components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from '../../components/ui/field';
import Loading from '../../components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '../../components/ui/modal';
import { Switch } from '../../components/ui/switch';
import { errorToast, successToast } from '../../components/ui/toast';
import { useGenuiCopyMessages } from '../../shared/features/genui/to-markdown';
import { getSessionDisplayTitle } from '../../shared/features/workspace/project-sidebar/project-session-list-helpers';
import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  formatTranscript,
  getTranscriptFilename,
  type ProjectSession,
  type TranscriptOptions,
} from '@kortix/sdk';
import {
  loadSessionExportMessages,
  useProjectSession,
  useRuntimeSession,
  useSessionSync,
} from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  CopyIcon as Copy,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download } from '../../shared/features/icon/icons/download';

// ============================================================================
// Export Modal
// ============================================================================

interface TranscriptSessionHeader {
  id: string;
  title: string;
  time: { created: number; updated: number };
}

/**
 * The transcript's header: the runtime's session while the computer runs, else
 * the session row the page shows (asleep, stopped, failed). Null: nothing to
 * name the export after yet.
 */
export function transcriptSessionHeader(
  runtime: { id: string; title?: string; slug?: string; time: { created: number; updated: number } } | undefined,
  row: ProjectSession | null,
  sessionId: string,
): TranscriptSessionHeader | null {
  if (runtime) {
    return { id: runtime.id, title: runtime.title || runtime.slug || 'Untitled', time: runtime.time };
  }
  if (!row) return null;
  return {
    id: sessionId,
    title: getSessionDisplayTitle(row),
    time: { created: Date.parse(row.created_at), updated: Date.parse(row.updated_at) },
  };
}

interface ExportTranscriptModalProps {
  sessionId: string;
  kortixSessionScope?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TRANSCRIPT_OPTIONS = [
  {
    key: 'assistantMetadata',
    id: 'opt-metadata',
    titleKey: 'componentsSessionExportTranscriptModal.line131JsxTextAssistantMetadata',
    descriptionKey: 'componentsSessionExportTranscriptModal.line131JsxTextAssistantMetadataDescription',
  },
  {
    key: 'toolDetails',
    id: 'opt-tools',
    titleKey: 'componentsSessionExportTranscriptModal.line145JsxTextToolCallDetails',
    descriptionKey: 'componentsSessionExportTranscriptModal.line145JsxTextToolCallDetailsDescription',
  },
  {
    key: 'thinking',
    id: 'opt-thinking',
    titleKey: 'componentsSessionExportTranscriptModal.line159JsxTextThinkingReasoning',
    descriptionKey: 'componentsSessionExportTranscriptModal.line159JsxTextThinkingReasoningDescription',
  },
] as const;

function TranscriptOptionToggle({
  id,
  label,
  description,
  checked,
  onToggle,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Field orientation="horizontal" variant="outline">
      <FieldContent>
        <FieldTitle>
          <label htmlFor={id} className="cursor-pointer">
            {label}
          </label>
        </FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onToggle} />
    </Field>
  );
}

export function ExportTranscriptModal({
  sessionId,
  kortixSessionScope,
  open,
  onOpenChange,
}: ExportTranscriptModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tGenui = useTranslations('genui');
  const [options, setOptions] = useState<TranscriptOptions>(DEFAULT_TRANSCRIPT_OPTIONS);
  const [copied, setCopied] = useState(false);

  const { data: runtimeSession } = useRuntimeSession(sessionId);
  // The row answers while the computer sleeps; the runtime session does not.
  const [projectId, projectSessionId] = kortixSessionScope?.split('/') ?? [];
  const { data: projectSession = null } = useProjectSession(projectId, projectSessionId, {
    enabled: !!projectId && !!projectSessionId,
  });
  const session = useMemo(
    () => transcriptSessionHeader(runtimeSession, projectSession, sessionId),
    [runtimeSession, projectSession, sessionId],
  );
  // `mirror: null`: this dialog is mounted with every session header, and the
  // page's `useSession` already reads the saved copy once per open.
  const { messages: visibleMessages } = useSessionSync(sessionId, { kortixSessionScope, mirror: null });
  const [messages, setMessages] = useState(visibleMessages);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const visibleMessagesRef = useRef(visibleMessages);
  useEffect(() => {
    visibleMessagesRef.current = visibleMessages;
  }, [visibleMessages]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setIsLoadingMessages(true);
    // The runtime's history while the computer runs, else the saved copy.
    void loadSessionExportMessages(sessionId, kortixSessionScope)
      .then((history) => {
        if (!cancelled) setMessages(history);
      })
      .catch(() => {
        if (!cancelled) {
          setMessages(visibleMessagesRef.current);
          errorToast(tHardcodedUi.raw('i18nComplete.texta867cd732dd7'));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, kortixSessionScope, tHardcodedUi]);

  // Generative UI blocks become markdown before copy or download, one message at a time. While the
  // converter loads, `transcript` is '' and both actions stay disabled.
  // The converter (a lazy chunk) failed to load: nothing was copied yet, so say what failed.
  const onConvertError = useCallback(() => errorToast(tGenui('convertFailed')), [tGenui]);
  const exportMessages = useGenuiCopyMessages(messages, onConvertError);
  const transcript = useMemo(() => {
    if (!session || !exportMessages || exportMessages.length === 0) return '';
    return formatTranscript(session, exportMessages, options);
  }, [session, exportMessages, options]);

  const filename = useMemo(() => {
    if (!session) return 'session.md';
    return getTranscriptFilename(session.id, session.title);
  }, [session]);

  const handleCopy = useCallback(async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      successToast(tHardcodedUi.raw('i18nComplete.text738211823996'));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast(tHardcodedUi.raw('i18nComplete.textb5b83b18d54b'));
    }
  }, [tHardcodedUi, transcript]);

  const handleDownload = useCallback(() => {
    if (!transcript) return;
    const blob = new Blob([transcript], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    successToast(tHardcodedUi('i18nComplete.text7eca5e05f915', { value0: filename }));
    onOpenChange(false);
  }, [transcript, filename, tHardcodedUi, onOpenChange]);

  const toggleOption = useCallback((key: keyof TranscriptOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const wordCount = useMemo(() => {
    if (!transcript) return 0;
    return transcript.split(/\s+/).filter(Boolean).length;
  }, [transcript]);

  const messageCount = messages.length;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>
            {tHardcodedUi.raw(
              'componentsSessionExportTranscriptModal.line118JsxTextExportTranscript',
            )}
          </ModalTitle>
          <ModalDescription>
            {tHardcodedUi.raw(
              'componentsSessionExportTranscriptModal.line121JsxTextExportThisSessionAsAMarkdownFileConfigure',
            )}
          </ModalDescription>
        </ModalHeader>

        <ModalBody>
          <FieldGroup className="gap-4">
            {TRANSCRIPT_OPTIONS.map(({ key, id, titleKey, descriptionKey }) => (
              <TranscriptOptionToggle
                key={key}
                id={id}
                label={tHardcodedUi.raw(titleKey)}
                description={tHardcodedUi.raw(descriptionKey)}
                checked={options[key]}
                onToggle={() => toggleOption(key)}
              />
            ))}
          </FieldGroup>

          <Field>
            <FieldContent className="flex flex-col items-start justify-start gap-2">
              <FieldTitle>{tHardcodedUi.raw('i18nComplete.text8e76a94ac832')}</FieldTitle>
              {isLoadingMessages ? (
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Loading />
                  {tHardcodedUi.raw(
                    'componentsSessionExportTranscriptModal.line176JsxTextLoadingMessages',
                  )}
                </span>
              ) : (
                <ul className="text-muted-foreground list-inside list-disc text-xs">
                  <li>
                    {messageCount} {tHardcodedUi.raw('i18nComplete.textab530a13e459')}
                    {messageCount !== 1 ? 's' : ''}
                  </li>
                  <li>
                    ~{wordCount.toLocaleString()}{' '}
                    {tHardcodedUi.raw('i18nComplete.textdba36bffa5ca')}
                  </li>
                </ul>
              )}
            </FieldContent>
          </Field>
        </ModalBody>

        <ModalFooter className="gap-2">
          <Button
            variant="outline-ghost"
            onClick={handleCopy}
            disabled={!transcript || isLoadingMessages}
            className="flex-1 sm:flex-none"
            size="sm"
          >
            {copied ? (
              <>
                <Check />
                {tHardcodedUi.raw('i18nComplete.text8d525e5f158b')}
              </>
            ) : (
              <>
                <Copy />
                {tHardcodedUi.raw('i18nComplete.texte21f935f11d7')}
              </>
            )}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={!transcript || isLoadingMessages}
            className="flex-1 sm:flex-none"
            size="sm"
          >
            {isLoadingMessages ? (
              <>
                <Loading />
                {tHardcodedUi.raw('i18nComplete.text47d2a515ef2f')}
              </>
            ) : (
              <>
                <Download />
                {tHardcodedUi.raw(
                  'componentsSessionExportTranscriptModal.line224JsxTextDownloadMd',
                )}
              </>
            )}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

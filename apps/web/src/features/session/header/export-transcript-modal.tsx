'use client';

import { useTranslations } from '@/i18n/use-translations';

import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldTitle,
} from '@/components/ui/field';
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
import { Switch } from '@/components/ui/switch';
import { errorToast, successToast } from '@/components/ui/toast';
import {
  DEFAULT_TRANSCRIPT_OPTIONS,
  formatTranscript,
  getTranscriptFilename,
  type TranscriptOptions,
} from '@kortix/sdk';
import {
  loadSessionTranscriptMessages,
  useRuntimeSession,
  useSessionSync,
} from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  CopyIcon as Copy,
  DownloadIcon as Download,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ============================================================================
// Export Modal
// ============================================================================

interface ExportTranscriptModalProps {
  sessionId: string;
  kortixSessionScope?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportTranscriptModal({
  sessionId,
  kortixSessionScope,
  open,
  onOpenChange,
}: ExportTranscriptModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [options, setOptions] = useState<TranscriptOptions>(DEFAULT_TRANSCRIPT_OPTIONS);
  const [copied, setCopied] = useState(false);

  const { data: session } = useRuntimeSession(sessionId);
  const { messages: visibleMessages } = useSessionSync(sessionId, { kortixSessionScope });
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
    void loadSessionTranscriptMessages(sessionId)
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
  }, [open, sessionId, tHardcodedUi]);

  const transcript = useMemo(() => {
    if (!session || messages.length === 0) return '';
    return formatTranscript(
      {
        id: session.id,
        title: session.title || session.slug || 'Untitled',
        time: session.time,
      },
      messages,
      options,
    );
  }, [session, messages, options]);

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
            <Field orientation="horizontal" variant="outline">
              <FieldContent>
                <FieldTitle>
                  <label htmlFor="opt-metadata" className="cursor-pointer">
                    {tHardcodedUi.raw(
                      'componentsSessionExportTranscriptModal.line131JsxTextAssistantMetadata',
                    )}
                  </label>
                </FieldTitle>
                <FieldDescription>
                  {tHardcodedUi.raw(
                    'componentsSessionExportTranscriptModal.line131JsxTextAssistantMetadataDescription',
                  )}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="opt-metadata"
                checked={options.assistantMetadata}
                onCheckedChange={() => toggleOption('assistantMetadata')}
              />
            </Field>

            <Field orientation="horizontal" variant="outline">
              <FieldContent>
                <FieldTitle>
                  <label htmlFor="opt-tools" className="cursor-pointer">
                    {tHardcodedUi.raw(
                      'componentsSessionExportTranscriptModal.line145JsxTextToolCallDetails',
                    )}
                  </label>
                </FieldTitle>
                <FieldDescription>
                  {tHardcodedUi.raw(
                    'componentsSessionExportTranscriptModal.line145JsxTextToolCallDetailsDescription',
                  )}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="opt-tools"
                checked={options.toolDetails}
                onCheckedChange={() => toggleOption('toolDetails')}
              />
            </Field>

            <Field orientation="horizontal" variant="outline">
              <FieldContent>
                <FieldTitle>
                  <label htmlFor="opt-thinking" className="cursor-pointer">
                    {tHardcodedUi.raw(
                      'componentsSessionExportTranscriptModal.line159JsxTextThinkingReasoning',
                    )}
                  </label>
                </FieldTitle>
                <FieldDescription>
                  {tHardcodedUi.raw(
                    'componentsSessionExportTranscriptModal.line159JsxTextThinkingReasoningDescription',
                  )}
                </FieldDescription>
              </FieldContent>
              <Switch
                id="opt-thinking"
                checked={options.thinking}
                onCheckedChange={() => toggleOption('thinking')}
              />
            </Field>
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

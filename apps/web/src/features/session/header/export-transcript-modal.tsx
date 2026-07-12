'use client';

import { useTranslations } from 'next-intl';

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
  getTranscriptFilename,
  type TranscriptOptions,
} from '@kortix/sdk';
import {
  getSessionTranscript,
  type SessionTranscript,
  type SessionTranscriptMessage,
} from '@kortix/sdk/projects-client';
import { Check, Copy, Download } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';

// ============================================================================
// Export Modal
// ============================================================================

interface ExportTranscriptModalProps {
  projectId: string | null;
  sessionId: string;
  sessionTitle?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportTranscriptModal({
  projectId,
  sessionId,
  sessionTitle,
  open,
  onOpenChange,
}: ExportTranscriptModalProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [options, setOptions] = useState<TranscriptOptions>(DEFAULT_TRANSCRIPT_OPTIONS);
  const [copied, setCopied] = useState(false);

  const { data: transcriptDigest, isLoading: isLoadingTranscript } = useQuery({
    queryKey: ['project-session-transcript', projectId, sessionId],
    queryFn: () => getSessionTranscript(projectId!, sessionId, { limit: 500, chars: 5000 }),
    enabled: open && !!projectId && !!sessionId,
    staleTime: 5_000,
  });

  const transcript = useMemo(() => {
    if (!transcriptDigest?.available || transcriptDigest.messages.length === 0) return '';
    return formatAcpTranscriptMarkdown({
      sessionId,
      title: sessionTitle,
      digest: transcriptDigest,
      options,
    });
  }, [transcriptDigest, sessionId, sessionTitle, options]);

  const filename = useMemo(() => {
    return getTranscriptFilename(sessionId, sessionTitle);
  }, [sessionId, sessionTitle]);

  const handleCopy = useCallback(async () => {
    if (!transcript) return;
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      successToast('Transcript copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      errorToast('Failed to copy to clipboard');
    }
  }, [transcript]);

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
    successToast(`Downloaded ${filename}`);
    onOpenChange(false);
  }, [transcript, filename, onOpenChange]);

  const toggleOption = useCallback((key: keyof TranscriptOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const wordCount = useMemo(() => {
    if (!transcript) return 0;
    return transcript.split(/\s+/).filter(Boolean).length;
  }, [transcript]);

  const messageCount = transcriptDigest?.message_count ?? 0;
  const unavailableReason = transcriptDigest && !transcriptDigest.available
    ? transcriptDigest.reason || 'Transcript export is unavailable for this session.'
    : null;

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
              <FieldTitle>Summary</FieldTitle>
              {isLoadingTranscript ? (
                <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Loading />
                  {tHardcodedUi.raw(
                    'componentsSessionExportTranscriptModal.line176JsxTextLoadingMessages',
                  )}
                </span>
              ) : unavailableReason ? (
                <span className="text-muted-foreground text-xs">{unavailableReason}</span>
              ) : (
                <ul className="text-muted-foreground list-inside list-disc text-xs">
                  <li>
                    {messageCount} message{messageCount !== 1 ? 's' : ''}
                  </li>
                  <li>~{wordCount.toLocaleString()} words</li>
                </ul>
              )}
            </FieldContent>
          </Field>
        </ModalBody>

        <ModalFooter className="gap-2">
          <Button
            variant="outline-ghost"
            onClick={handleCopy}
            disabled={!transcript || isLoadingTranscript}
            className="flex-1 sm:flex-none"
            size="sm"
          >
            {copied ? (
              <>
                <Check />
                Copied
              </>
            ) : (
              <>
                <Copy />
                Copy
              </>
            )}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={!transcript || isLoadingTranscript}
            className="flex-1 sm:flex-none"
            size="sm"
          >
            {isLoadingTranscript ? (
              <>
                <Loading />
                Loading...
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

function formatAcpTranscriptMarkdown({
  sessionId,
  title,
  digest,
  options,
}: {
  sessionId: string;
  title?: string;
  digest: SessionTranscript;
  options: TranscriptOptions;
}): string {
  const lines = [
    `# ${title || 'Agent transcript'}`,
    '',
    `**Session ID:** \`${sessionId}\``,
  ];
  if (digest.runtime_session_id) lines.push(`**Runtime session ID:** \`${digest.runtime_session_id}\``);
  lines.push('', '---', '');

  for (const message of digest.messages) {
    lines.push(formatAcpMessage(message, options), '---', '');
  }

  return lines.join('\n');
}

function formatAcpMessage(message: SessionTranscriptMessage, options: TranscriptOptions): string {
  const role = message.role === 'user' ? 'User' : 'Assistant';
  const metadata: string[] = [];
  if (options.assistantMetadata && message.created) {
    metadata.push(new Date(message.created).toLocaleString());
  }
  const header = metadata.length > 0 ? `## ${role} (${metadata.join(' · ')})` : `## ${role}`;
  const lines = [header, '', message.text || '_No text content._', ''];

  if (message.reasoning_omitted && options.thinking) {
    lines.push('> Reasoning/thinking was present but omitted from the sanitized ACP transcript.', '');
  }

  if (message.tools.length > 0 && options.toolDetails) {
    lines.push('**Tools**', '');
    for (const tool of message.tools) {
      lines.push(`- ${tool.tool}${tool.status ? ` — ${tool.status}` : ''}`);
    }
    lines.push('');
  }

  if (message.error?.message) {
    lines.push(`**Error:** ${message.error.message}`, '');
  }

  return lines.join('\n');
}

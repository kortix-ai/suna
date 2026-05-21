'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Download,
  Copy,
  Check,
  FileDown,
  Brain,
  Wrench,
  Bot,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useOpenCodeSession } from '@/hooks/opencode/use-opencode-sessions';
import { useSessionSync } from '@/hooks/opencode/use-session-sync';
import {
  formatTranscript,
  getTranscriptFilename,
  DEFAULT_TRANSCRIPT_OPTIONS,
  type TranscriptOptions,
} from '@/lib/transcript';
import { toast } from '@/lib/toast';

// ============================================================================
// Export Dialog
// ============================================================================

interface ExportTranscriptDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportTranscriptDialog({
  sessionId,
  open,
  onOpenChange,
}: ExportTranscriptDialogProps) {
  const [options, setOptions] = useState<TranscriptOptions>(DEFAULT_TRANSCRIPT_OPTIONS);
  const [copied, setCopied] = useState(false);

  const { data: session } = useOpenCodeSession(sessionId);
  const { messages, isLoading: isLoadingMessages } = useSessionSync(sessionId);

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
      toast.success('Transcript copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
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
    toast.success(`Downloaded ${filename}`);
    onOpenChange(false);
  }, [transcript, filename, onOpenChange]);

  const toggleOption = useCallback((key: keyof TranscriptOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const wordCount = useMemo(() => {
    if (!transcript) return 0;
    return transcript.split(/\s+/).filter(Boolean).length;
  }, [transcript]);

  const messageCount = messages.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-4 w-4" />
            Export Transcript
          </DialogTitle>
          <DialogDescription className="text-sm leading-relaxed">
            Export this session as a Markdown file. Configure what to include below.
          </DialogDescription>
        </DialogHeader>

        {/* Options */}
        <div className="space-y-3">
          <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-muted/30 px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <Bot className="h-3.5 w-3.5 text-muted-foreground" />
              <Label htmlFor="opt-metadata" className="text-sm cursor-pointer">
                Assistant metadata
              </Label>
            </div>
            <Switch
              id="opt-metadata"
              checked={options.assistantMetadata}
              onCheckedChange={() => toggleOption('assistantMetadata')}
            />
          </div>

          <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-muted/30 px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
              <Label htmlFor="opt-tools" className="text-sm cursor-pointer">
                Tool call details
              </Label>
            </div>
            <Switch
              id="opt-tools"
              checked={options.toolDetails}
              onCheckedChange={() => toggleOption('toolDetails')}
            />
          </div>

          <div className="flex items-center justify-between rounded-2xl border border-border/40 bg-muted/30 px-3 py-2.5">
            <div className="flex items-center gap-2.5">
              <Brain className="h-3.5 w-3.5 text-muted-foreground" />
              <Label htmlFor="opt-thinking" className="text-sm cursor-pointer">
                Thinking / reasoning
              </Label>
            </div>
            <Switch
              id="opt-thinking"
              checked={options.thinking}
              onCheckedChange={() => toggleOption('thinking')}
            />
          </div>
        </div>

        {/* Preview stats */}
        <div className="rounded-2xl bg-muted/50 border border-border/40 px-3 py-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {isLoadingMessages ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading messages...
              </span>
            ) : (
              <>
                {messageCount} message{messageCount !== 1 ? 's' : ''}
                {' · '}
                ~{wordCount.toLocaleString()} words
              </>
            )}
          </span>
          <span className="text-xs text-muted-foreground font-mono">
            {filename}
          </span>
        </div>

        {/* Actions */}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            variant="outline"
            onClick={handleCopy}
            disabled={!transcript || isLoadingMessages}
            className="flex-1 sm:flex-none"
          >
            {copied ? (
              <>
                <Check className="mr-2 h-3.5 w-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-2 h-3.5 w-3.5" />
                Copy
              </>
            )}
          </Button>
          <Button
            onClick={handleDownload}
            disabled={!transcript || isLoadingMessages}
            className="flex-1 sm:flex-none"
          >
            {isLoadingMessages ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <Download className="mr-2 h-3.5 w-3.5" />
                Download .md
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

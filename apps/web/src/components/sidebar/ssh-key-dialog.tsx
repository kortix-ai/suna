'use client';

import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import {
  Key,
  Loader2,
  Copy,
  Check,
  Download,
  Terminal,
  Code2,
  Monitor,
  KeyRound,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { getSSHConnection, setupSSH, type SSHConnectionInfo, type SSHSetupResult } from '@/lib/platform-client';
import { getActiveInstanceId } from '@/stores/server-store';
import { toast } from '@/lib/toast';

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface SSHKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SSH_META_STORAGE_KEY = 'kortix:ssh-access-meta:v1';

type SSHAccessMeta = {
  ssh_command: string;
  reconnect_command: string;
  ssh_config_entry: string;
  ssh_config_command: string;
  host: string;
  port: number;
  username: string;
  provider: string;
  key_name: string;
  host_alias: string;
  updatedAt: number;
};

/* ─── Copy hook ──────────────────────────────────────────────────────────── */

function useCopy(text: string, label?: string) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const copy = useCallback(() => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success(label ? `${label} copied` : 'Copied');
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  }, [text, label]);
  return { copied, copy };
}

/* ─── Primitives ─────────────────────────────────────────────────────────── */

function CopyOverlay({ copied }: { copied: boolean }) {
  return (
    <div className={cn(
      'absolute top-1.5 right-1.5 z-10 flex items-center justify-center h-6 w-6 rounded-md transition-colors',
      copied
        ? 'bg-emerald-500/15 text-emerald-400'
        : 'bg-background/60 text-muted-foreground opacity-0 group-hover:opacity-100 backdrop-blur-sm',
    )}>
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </div>
  );
}

function InlineCopyButton({ text, label }: { text: string; label?: string }) {
  const { copied, copy } = useCopy(text, label);
  return (
    <Button
      type="button"
      onClick={copy}
      variant={copied ? 'success' : 'outline'}
      size="toolbar"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );
}

/** Visible code block — click anywhere to copy */
function VisibleCodeBlock({ text, label, variant = 'default' }: {
  text: string;
  label?: string;
  variant?: 'default' | 'green';
}) {
  const { copied, copy } = useCopy(text, label);
  return (
    <div className="relative group cursor-pointer min-w-0 w-full" onClick={copy}>
      <pre className={cn(
        'px-3 py-2.5 rounded-md text-[10.5px] font-mono border overflow-x-auto transition-colors leading-relaxed max-w-full whitespace-pre-wrap break-all',
        'bg-muted/40 border-border/50 hover:border-border',
        variant === 'green' ? 'text-emerald-400' : 'text-foreground/80',
      )}>
        {text}
      </pre>
      <CopyOverlay copied={copied} />
    </div>
  );
}

/** Masked code block — private key hidden, click to copy full text */
function SecretCodeBlock({ text, label }: { text: string; label?: string }) {
  const { copied, copy } = useCopy(text, label);

  // Mask the private key: show first 6 chars after heredoc then bullets
  const masked = text.replace(
    /(cat > [^\n]+<< 'KORTIX_KEY'\n)([^\n]{6})[^]*?(KORTIX_KEY)/,
    '$1$2••••••••••••\n$3',
  );
  const finalMasked = masked.replace(
    /(echo\s+')([^']{6})[^']*('[^']*)/,
    '$1$2••••••$3',
  );

  return (
    <div className="relative group cursor-pointer min-w-0 w-full" onClick={copy}>
      <div className="rounded-md border border-border/50 overflow-hidden transition-colors hover:border-border">
        <p className="px-3 py-2.5 text-[10.5px] font-mono text-foreground/70 truncate leading-relaxed bg-muted/40">
          {finalMasked}
        </p>
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-t border-border/30 bg-muted/20">
          <KeyRound className="h-2.5 w-2.5 text-muted-foreground/50 shrink-0" />
          <span className="text-[10px] text-muted-foreground/50">Private key hidden — click to copy full command</span>
        </div>
      </div>
      <CopyOverlay copied={copied} />
    </div>
  );
}

/* ─── Shared SSH result view (used by both dialog and server-selector) ─── */

export function SSHResultView({ sshResult, copiedField, onCopy, onRegenerate, isGenerating, onDownloadKey }: {
  sshResult: SSHSetupResult;
  copiedField: string | null;
  onCopy: (text: string, field: string) => void;
  onRegenerate: () => void;
  isGenerating: boolean;
  onDownloadKey: () => void;
}) {
  const setupCmd = sshResult.setup_command;
  const reconnectCmd = sshResult.reconnect_command;
  const sshConfigCmd = sshResult.ssh_config_command;
  const agentPrompt = sshResult.agent_prompt;

  return (
    <div className="flex flex-col gap-3">

      {/* ── AI agent shortcut ── */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <div className="flex items-start gap-3 p-3">
          <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
            <Code2 className="h-3.5 w-3.5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground mb-0.5">Let your AI agent do it</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Copy this prompt into{' '}
              <span className="text-foreground/80 font-medium">Claude Code, Cursor, Codex</span>
              {' '}— it contains your key so the agent sets everything up.
            </p>
          </div>
          <InlineCopyButton text={agentPrompt} label="Agent prompt" />
        </div>
      </div>

      {/* ── Divider ── */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border/40" />
        <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">or manually</span>
        <div className="h-px flex-1 bg-border/40" />
      </div>

      {/* ── Step 1: Save SSH key & connect ── */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/20">
          <span className="h-5 w-5 rounded-full bg-foreground text-background text-[10px] font-semibold flex items-center justify-center shrink-0">1</span>
          <span className="text-xs font-medium">Save SSH key &amp; connect</span>
          <div className="ml-auto flex items-center gap-1 text-[10px] text-amber-500 dark:text-amber-400">
            <KeyRound className="h-2.5 w-2.5" />
            <span>Contains private key</span>
          </div>
        </div>
        <div className="p-3 space-y-2 min-w-0">
          <p className="text-[10px] text-muted-foreground">
            Run once in your terminal — saves your key and opens an SSH session.
          </p>
          <SecretCodeBlock text={setupCmd} label="Setup command" />
          <p className="text-[10px] text-muted-foreground mt-2">Reconnect later:</p>
          <VisibleCodeBlock text={reconnectCmd} label="SSH command" />
        </div>
      </div>

      {/* ── Step 2: Open in your editor ── */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-muted/20">
          <span className="h-5 w-5 rounded-full bg-foreground text-background text-[10px] font-semibold flex items-center justify-center shrink-0">2</span>
          <span className="text-xs font-medium">Open in your editor</span>
        </div>
        <div className="divide-y divide-border/30">
          {/* Cursor / VS Code */}
          <div className="p-3 space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <Monitor className="h-3.5 w-3.5 text-muted-foreground/70" />
              <span className="text-xs font-medium">Cursor / VS Code</span>
              <span className="text-[0.5625rem] font-medium bg-primary/10 text-primary border border-primary/20 px-1.5 py-0.5 rounded-full leading-none">
                Recommended
              </span>
            </div>
            <p className="text-[10px] text-muted-foreground">Add host to SSH config (run once):</p>
            <VisibleCodeBlock text={sshConfigCmd} label="SSH config" variant="green" />
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Then{' '}
              <kbd className="px-1 py-0.5 rounded-sm bg-muted border border-border/50 text-[0.5625rem] font-mono text-foreground/70">Cmd+Shift+P</kbd>
              {' → '}
              <span className="text-foreground/70">Remote-SSH: Connect to Host</span>
              {' → '}
              <code className="px-1 py-0.5 rounded-sm bg-muted border border-border/50 font-mono text-[10px] text-foreground/80">{sshResult.host_alias}</code>
            </p>
          </div>

          {/* Plain SSH */}
          <div className="p-3 space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground/70" />
              <span className="text-xs font-medium">Terminal / Plain SSH</span>
            </div>
            <VisibleCodeBlock text={reconnectCmd} label="SSH command" />
          </div>
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between pt-1 border-t border-border/30">
        <Button
          type="button"
          onClick={onDownloadKey}
          variant="muted"
          size="toolbar"
        >
          <Download className="h-3 w-3" />
          Download key file
        </Button>
        <Button
          type="button"
          variant="outline"
          size="toolbar"
          onClick={onRegenerate}
          disabled={isGenerating}
        >
          {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Regenerate'}
        </Button>
      </div>
    </div>
  );
}

/* ─── Main dialog ────────────────────────────────────────────────────────── */

export function SSHKeyDialog({ open, onOpenChange }: SSHKeyDialogProps) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [sshResult, setSSHResult] = useState<SSHSetupResult | null>(null);
  const [sshMeta, setSSHMeta] = useState<SSHAccessMeta | null>(null);
  const [sshError, setSSHError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    try {
      const raw = localStorage.getItem(SSH_META_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as SSHAccessMeta;
      if (parsed?.ssh_command && parsed?.host && parsed?.username && parsed?.port) {
        setSSHMeta(parsed);
      }
    } catch {}

    const instanceId = getActiveInstanceId();
    getSSHConnection(instanceId).then((connection: SSHConnectionInfo) => {
      setSSHMeta((prev) => ({
        ...connection,
        updatedAt: prev?.updatedAt || Date.now(),
      }));
    }).catch(() => {});
  }, [open]);

  const handleGenerate = useCallback(async () => {
    setIsGenerating(true);
    setSSHError(null);
    setSSHResult(null);
    try {
      const instanceId = getActiveInstanceId();
      const result = await setupSSH(instanceId);
      setSSHResult(result);
      const meta: SSHAccessMeta = {
        ...result,
        updatedAt: Date.now(),
      };
      setSSHMeta(meta);
      try {
        localStorage.setItem(SSH_META_STORAGE_KEY, JSON.stringify(meta));
      } catch {}
      toast.success('SSH key generated');
    } catch (err: any) {
      setSSHError(err?.message || 'Failed to generate SSH keys');
      toast.error(err?.message || 'Failed to generate SSH keys');
    } finally {
      setIsGenerating(false);
    }
  }, []);

  function copyToClipboard(text: string, field: string) {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    toast.success('Copied');
    setTimeout(() => setCopiedField(null), 2000);
  }

  function savePrivateKey() {
    if (!sshResult) return;
    const blob = new Blob([sshResult.private_key], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sshResult.key_name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Key downloaded — run: chmod 600 ~/Downloads/${sshResult.key_name}`);
  }

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setSSHResult(null);
      setSSHError(null);
      setCopiedField(null);
    }
    onOpenChange(next);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(92vw,560px)] sm:max-w-lg max-h-[85vh] p-0 gap-0 flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-3 shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Key className="h-4 w-4" />
            SSH Access
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Connect to your Kortix instance via your IDE so it feels like home.
          </DialogDescription>
        </DialogHeader>

        {/* ── Generate view ── */}
        {!sshResult && (
          <div className="flex flex-col gap-3 px-5 pb-5">
            {sshError && (
              <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                {sshError}
              </p>
            )}

            <Button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating}
              size="default"
              className="w-full"
            >
              {isGenerating ? (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</>
              ) : (
                <><Key className="h-3.5 w-3.5" /> Generate SSH Key</>
              )}
            </Button>
            <p className="text-[10px] text-muted-foreground/60 text-center">
              Generates a fresh ed25519 keypair and configures SSH access.
            </p>

            {sshMeta && (
              <div className="rounded-lg border border-border/50 p-3 space-y-2">
                <p className="text-xs font-medium text-foreground/80">Reconnect command</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 text-[10px] font-mono bg-muted/40 border border-border/50 rounded-md px-2.5 py-1.5 text-foreground/70 truncate select-all">
                    {sshMeta.ssh_command}
                  </code>
                  <InlineCopyButton text={sshMeta.ssh_command} label="Reconnect" />
                </div>
                <p className="text-[0.5625rem] text-muted-foreground/40">
                  From {new Date(sshMeta.updatedAt).toLocaleString()}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Result view — scrollable ── */}
        {sshResult && (
          <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-5">
            <SSHResultView
              sshResult={sshResult}
              copiedField={copiedField}
              onCopy={copyToClipboard}
              onRegenerate={handleGenerate}
              isGenerating={isGenerating}
              onDownloadKey={savePrivateKey}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

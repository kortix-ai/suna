'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Check, XCircle, ArrowDownToLine, RotateCw, Sparkles, Bug, Zap, AlertTriangle, Shield, RefreshCw, Terminal, Copy } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { authenticatedFetch } from '@/lib/auth-token';
import { useServerStore } from '@/stores/server-store';
import { getEnv } from '@/lib/env-config';
import type { UpdatePhase } from '@/hooks/platform/use-sandbox-update';
import type { ChangelogEntry, ChangelogChange } from '@/lib/platform-client';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

type DialogStep = 'confirm' | 'updating' | 'done' | 'failed';

const changeTypeConfig: Record<string, { icon: typeof Sparkles; color: string }> = {
  feature:     { icon: Sparkles,      color: 'text-emerald-500' },
  fix:         { icon: Bug,           color: 'text-red-400' },
  improvement: { icon: Zap,           color: 'text-blue-400' },
  breaking:    { icon: AlertTriangle, color: 'text-amber-500' },
  upstream:    { icon: RefreshCw,     color: 'text-violet-400' },
  security:    { icon: Shield,        color: 'text-rose-400' },
  deprecation: { icon: AlertTriangle, color: 'text-orange-400' },
};

function ChangeItem({ change }: { change: ChangelogChange }) {
  const config = changeTypeConfig[change.type] ?? changeTypeConfig.improvement;
  const Icon = config.icon;
  return (
    <div className="flex items-start gap-2 py-0.5">
      <Icon className={cn('h-3.5 w-3.5 mt-0.5 flex-shrink-0', config.color)} />
      <span className="text-sm text-foreground/80">{change.text}</span>
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  idle: 'Preparing...',
  backing_up: 'Creating backup...',
  pulling: 'Downloading update...',
  patching: 'Preparing files...',
  stopping: 'Stopping sandbox...',
  restarting: 'Restarting sandbox...',
  verifying: 'Verifying update...',
  complete: 'Update complete',
  reconnecting: 'Reconnecting...',
  reconnected: 'Connected',
};

interface UpdateDialogProps {
  open: boolean;
  phase: UpdatePhase;
  phaseMessage: string;
  phaseProgress: number;
  latestVersion: string | null;
  changelog: ChangelogEntry | null;
  currentVersion: string | null;
  isLocalSelfHosted?: boolean;
  errorMessage: string | null;
  updateResult: { success: boolean; currentVersion: string } | null;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  isDev?: boolean;
}

function formatVersion(version: string | null | undefined): string {
  if (!version) return 'unknown';
  return version.startsWith('dev-') ? version : `v${version}`;
}

export function UpdateDialog({
  open,
  phase,
  phaseMessage,
  phaseProgress,
  latestVersion,
  changelog,
  currentVersion,
  isLocalSelfHosted,
  errorMessage,
  updateResult,
  onClose,
  onConfirm,
  onRetry,
  isDev,
}: UpdateDialogProps) {
  const [userRequested, setUserRequested] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [isReconnected, setIsReconnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const healthPollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step: DialogStep = useMemo(() => {
    if (isReconnected) return 'done';
    if (userRequested && phase !== 'complete') return 'updating';
    if (phase === 'failed') return 'failed';
    if (phase !== 'idle') return 'updating';
    return 'confirm';
  }, [phase, userRequested, isReconnected]);

  useEffect(() => {
    if (phase === 'failed') setUserRequested(false);
  }, [phase]);

  const isComplete = phase === 'complete';
  const isFailed = phase === 'failed';

  useEffect(() => {
    if (!open) {
      if (healthPollRef.current) clearTimeout(healthPollRef.current);
      return;
    }
    setExpanded(false);
    setIsReconnected(false);
    setIsReconnecting(false);
    setUserRequested(phase !== 'idle' && phase !== 'failed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pollHealth = useCallback(async () => {
    const state = useServerStore.getState();
    const active = state.servers.find((s) => s.id === state.activeServerId);
    if (!active?.sandboxId) return false;

    const backendUrl = (getEnv().BACKEND_URL || 'http://localhost:8008/v1').replace(/\/+$/, '');
    const url = `${backendUrl}/p/${active.sandboxId}/8000/global/health`;

    try {
      const res = await authenticatedFetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isComplete || isFailed || isReconnected) return;

    setIsReconnecting(true);
    let attempts = 0;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      attempts++;
      const healthy = await pollHealth();
      if (cancelled) return;
      if (healthy || attempts >= 30) {
        setIsReconnecting(false);
        setIsReconnected(true);
        return;
      }
      healthPollRef.current = setTimeout(poll, 2000);
    };

    healthPollRef.current = setTimeout(poll, 3000);
    return () => {
      cancelled = true;
      if (healthPollRef.current) clearTimeout(healthPollRef.current);
    };
  }, [isComplete, isFailed, isReconnected, pollHealth]);

  const playedCompletionRef = useRef(false);
  useEffect(() => {
    if (step !== 'done') {
      playedCompletionRef.current = false;
      return;
    }
    if (playedCompletionRef.current) return;
    playedCompletionRef.current = true;
    try {
      const audio = new Audio('/sounds/kortix/bootup.wav');
      audio.volume = 0.6;
      audio.play().catch(() => {});
    } catch {}
  }, [step]);

  useEffect(() => {
    if (step !== 'done' || isDev) return;
    const timer = setTimeout(onClose, 2500);
    return () => clearTimeout(timer);
  }, [step, onClose, isDev]);

  const handleConfirm = () => {
    setUserRequested(true);
    onConfirm();
  };

  const copyCliCommand = async () => {
    try {
      await navigator.clipboard.writeText('kortix update');
    } catch {}
  };

  const changes = changelog?.changes ?? [];
  const visibleChanges = expanded ? changes : changes.slice(0, 4);
  const hasMore = changes.length > 4 && !expanded;

  const circularProgress = isReconnected ? 100 : isReconnecting ? 95 : phaseProgress;
  const activeLabel = isReconnected
    ? PHASE_LABEL.reconnected
    : isReconnecting
      ? PHASE_LABEL.reconnecting
      : PHASE_LABEL[phase] ?? 'Updating...';

  if (open && step !== 'confirm') {
    const pct = Math.max(0, Math.min(100, circularProgress));
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background">
        {step === 'updating' && (
          <p className="absolute bottom-10 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/60">
            It's not recommended to refresh this tab during the update.
          </p>
        )}
        <AnimatePresence mode="wait">
          {step === 'updating' && (
            <motion.div
              key="updating-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-col items-center"
            >
              <KortixLogo size={28} variant="symbol" />
              <div className="mt-8 h-[2px] w-[240px] rounded-full bg-foreground/10 overflow-hidden">
                <motion.div
                  className="h-full bg-foreground"
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                />
              </div>
            </motion.div>
          )}

          {step === 'done' && (
            <motion.div
              key="done-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              <div className="relative flex h-10 w-10 items-center justify-center">
                <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping" />
                <motion.div
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 240, damping: 18 }}
                  className="relative flex h-10 w-10 items-center justify-center rounded-full bg-primary"
                >
                  <Check className="h-5 w-5 text-primary-foreground" strokeWidth={3} />
                </motion.div>
              </div>
              <motion.p
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 }}
                className="mt-5 text-[13px] font-medium text-foreground/90 tracking-tight"
              >
                Updated to <span className="tabular-nums">{formatVersion(updateResult?.currentVersion ?? latestVersion)}</span>
              </motion.p>
            </motion.div>
          )}

          {step === 'failed' && (
            <motion.div
              key="failed-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center max-w-md px-6"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/15">
                <XCircle className="h-5 w-5 text-red-500" />
              </div>
              <p className="mt-5 text-[13px] font-medium text-foreground/90 tracking-tight">
                Update failed
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground/70 text-center">
                {phaseMessage || 'Something went wrong.'}
              </p>
              {errorMessage && (
                <div className="mt-5 w-full max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/30 px-3 py-2 font-mono text-[10px] text-foreground/70">
                  {errorMessage}
                </div>
              )}
              <div className="mt-6 flex gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
                <Button size="sm" onClick={() => { setUserRequested(true); onRetry(); }} className="gap-1.5">
                  <RotateCw className="h-3 w-3" />
                  Retry
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && step === 'confirm') onClose(); }}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ArrowDownToLine className="h-5 w-5 text-primary" />
            Update to {formatVersion(latestVersion)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {currentVersion
              ? <>Your sandbox is running <span className="font-mono font-medium text-foreground">{formatVersion(currentVersion)}</span>.</>
              : 'A new version is available.'}
            {' '}This will restart your sandbox.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AnimatePresence mode="wait">
          {step === 'confirm' && (
            <motion.div key="confirm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {isLocalSelfHosted ? (
                <Alert variant="warning" className="mt-4">
                  <Terminal className="h-4 w-4" />
                  <AlertTitle>Self-hosted updates run from the host</AlertTitle>
                  <AlertDescription>
                    <p>
                      If you installed Kortix via the CLI, updates should be run from your terminal so the full stack updates together.
                    </p>
                    <div className="mt-2 rounded-xl bg-muted/40 px-3 py-2 font-mono text-xs text-foreground/80">
                      kortix update
                    </div>
                  </AlertDescription>
                </Alert>
              ) : changes.length > 0 && (
                <div className="rounded-lg border border-border/50 bg-muted/30 mt-4">
                  <div className="max-h-72 overflow-y-auto px-3 py-2.5 space-y-0.5">
                    {visibleChanges.map((change, i) => (
                      <ChangeItem key={i} change={change} />
                    ))}
                  </div>
                  {hasMore && (
                    <Button
                      onClick={() => setExpanded(true)}
                      variant="link"
                      size="sm"
                      className="w-full border-t border-border/30 rounded-none h-auto py-2"
                    >
                      Show {changes.length - 4} more changes
                    </Button>
                  )}
                </div>
              )}

              <AlertDialogFooter className="mt-4">
                <Button variant="outline" onClick={onClose}>Cancel</Button>
                {isLocalSelfHosted ? (
                  <Button onClick={copyCliCommand} className="gap-2">
                    <Copy className="h-4 w-4" />
                    Copy command
                  </Button>
                ) : (
                  <Button onClick={handleConfirm} className="gap-2">
                    <ArrowDownToLine className="h-4 w-4" />
                    Update now
                  </Button>
                )}
              </AlertDialogFooter>
            </motion.div>
          )}

        </AnimatePresence>
      </AlertDialogContent>
    </AlertDialog>
  );
}

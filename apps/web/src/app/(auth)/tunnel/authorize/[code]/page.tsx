'use client';

import { Check } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen, AuthStatusScreen } from '@/features/auth/auth-consent';
import { FieldLabel, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { CAPABILITY_REGISTRY } from '@/features/tunnel/types';
import {
  useApproveDeviceAuth,
  useDenyDeviceAuth,
  useDeviceAuthInfo,
} from '@/hooks/tunnel/use-tunnel';
import { cn } from '@/lib/utils';

export default function DeviceAuthorizePage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <DeviceAuthorize />
    </Suspense>
  );
}

function DeviceAuthorize() {
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;
  const { user, isLoading: authLoading } = useAuth();

  const { data: info, isLoading, error } = useDeviceAuthInfo(code);
  const approve = useApproveDeviceAuth();
  const deny = useDenyDeviceAuth();

  const [name, setName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(
    new Set(['filesystem', 'shell', 'desktop']),
  );
  const [done, setDone] = useState<'approved' | 'denied' | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`/auth?returnUrl=${encodeURIComponent(`/tunnel/authorize/${code}`)}`);
    }
  }, [user, authLoading, router, code]);

  useEffect(() => {
    if (info?.machineHostname && !name) {
      setName(info.machineHostname);
    }
  }, [info?.machineHostname, name]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const remaining = useMemo(() => {
    if (!info?.expiresAt) return 0;
    return Math.max(0, Math.floor((new Date(info.expiresAt).getTime() - now) / 1000));
  }, [info?.expiresAt, now]);

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  const toggleCap = (key: string) => {
    setSelectedCaps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleApprove = async () => {
    await approve.mutateAsync({
      code,
      name: name || info?.machineHostname || 'Unnamed',
      capabilities: Array.from(selectedCaps),
    });
    setDone('approved');
  };

  const handleDeny = async () => {
    await deny.mutateAsync(code);
    setDone('denied');
  };

  // ── Loading ──
  if (authLoading || isLoading) {
    return <AuthPendingScreen />;
  }

  // ── Not found ──
  if (error || !info) {
    return (
      <AuthStatusScreen
        title="Request not found"
        description="This authorization request doesn't exist or has already been used."
      />
    );
  }

  // ── Expired ──
  if (info.status === 'expired' || remaining <= 0) {
    return (
      <AuthStatusScreen
        title="Request expired"
        description="This authorization request has expired. Run the connect command again to get a fresh code."
      />
    );
  }

  // ── Done (approved / denied) ──
  if (info.status !== 'pending' || done) {
    const isApproved = done === 'approved' || info.status === 'approved';
    return (
      <AuthStatusScreen
        title={isApproved ? 'Device authorized' : 'Request denied'}
        description={
          isApproved
            ? 'The device is now connecting. You can close this tab.'
            : 'The authorization request was denied.'
        }
      />
    );
  }

  const busy = approve.isPending || deny.isPending;

  // ── Main form ──
  return (
    <AuthFrame>
      <Rise>
        <StepHeader
          title="Authorize this device"
          description="Check that the code below matches the one in your terminal."
        />
      </Rise>

      <Rise delay={0.06}>
        <div className="space-y-5">
          <div className="border-border flex items-center justify-between gap-3 rounded-md border px-3.5 py-3">
            <span className="text-foreground font-mono text-lg font-medium tracking-[0.15em] tabular-nums">
              {info.deviceCode}
            </span>
            <span className="text-muted-foreground font-mono text-xs tabular-nums">
              {minutes}:{seconds.toString().padStart(2, '0')}
            </span>
          </div>

          <div className="space-y-3">
            <FieldLabel htmlFor="connection-name">Connection name</FieldLabel>
            <Input
              id="connection-name"
              type="text"
              size="md"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={info.machineHostname || 'Connection name'}
            />
          </div>

          <div className="space-y-3">
            <p className="text-muted-foreground text-sm font-medium">Allow this device to use</p>
            <div className="border-border divide-border/60 divide-y overflow-hidden rounded-md border">
              {CAPABILITY_REGISTRY.filter((cap) =>
                ['filesystem', 'shell', 'desktop'].includes(cap.key),
              ).map((cap) => {
                const CapIcon = cap.icon;
                const selected = selectedCaps.has(cap.key);
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => toggleCap(cap.key)}
                    aria-pressed={selected}
                    className={cn(
                      'flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors',
                      selected ? 'bg-primary/[0.04]' : 'hover:bg-muted/40',
                    )}
                  >
                    <CapIcon
                      className={cn(
                        'size-5 shrink-0',
                        selected ? 'text-foreground/70' : 'text-muted-foreground/50',
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block text-sm',
                          selected ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {cap.label}
                      </span>
                      <span className="text-muted-foreground/70 block truncate text-xs">
                        {cap.description}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors',
                        selected ? 'border-foreground bg-foreground' : 'border-border',
                      )}
                    >
                      {selected && <Check className="text-background size-3" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3">
            <Button size="lg" className="w-full" onClick={handleApprove} disabled={busy}>
              {approve.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Approve connection
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive focus-visible:ring-destructive/35 w-full"
              onClick={handleDeny}
              disabled={busy}
            >
              {deny.isPending ? <Loading className="text-destructive! size-4 shrink-0" /> : null}
              Deny request
            </Button>
          </div>
        </div>
      </Rise>
    </AuthFrame>
  );
}

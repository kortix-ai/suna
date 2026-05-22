'use client';

import { Suspense, useEffect, useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { Check, X, Clock, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useDeviceAuthInfo,
  useApproveDeviceAuth,
  useDenyDeviceAuth,
} from '@/hooks/tunnel/use-tunnel';
import { CAPABILITY_REGISTRY } from '@/components/tunnel/types';

export default function DeviceAuthorizePage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 bg-background flex items-center justify-center">
          <KortixLoader size="medium" />
        </div>
      }
    >
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
    new Set(['filesystem', 'shell']),
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
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <KortixLoader size="medium" />
      </div>
    );
  }

  // ── Not found ──
  if (error || !info) {
    return (
      <StatusScreen
        icon={<X className="h-6 w-6 text-foreground/50" />}
        title="Request Not Found"
        description="This authorization request doesn't exist or has expired."
      />
    );
  }

  // ── Expired ──
  if (info.status === 'expired' || remaining <= 0) {
    return (
      <StatusScreen
        icon={<Clock className="h-6 w-6 text-amber-600 dark:text-amber-400" />}
        iconClassName="bg-amber-500/10 border-amber-500/20"
        title="Request Expired"
        description="This authorization request has expired. Run the connect command again."
      />
    );
  }

  // ── Done (approved / denied) ──
  if (info.status !== 'pending' || done) {
    const isApproved = done === 'approved' || info.status === 'approved';
    return (
      <StatusScreen
        icon={isApproved
          ? <Check className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          : <X className="h-6 w-6 text-destructive" />
        }
        iconClassName={isApproved
          ? 'bg-emerald-500/10 border-emerald-500/20'
          : 'bg-destructive/10 border-destructive/20'
        }
        title={isApproved ? 'Device Authorized' : 'Request Denied'}
        description={isApproved
          ? 'The device is now connecting. You can close this tab.'
          : 'The authorization request was denied.'
        }
      />
    );
  }

  // ── Main form ──
  return (
    <div className="fixed inset-0 overflow-hidden">
      <WallpaperBackground />

      <div className="absolute inset-0 bg-background/20 backdrop-blur-[2px]" />

      <div className="relative z-10 flex flex-col items-center justify-center h-full px-4">
        <div className="w-full max-w-[380px]">
          <div className="bg-background/80 dark:bg-background/75 backdrop-blur-2xl border border-foreground/[0.06] rounded-2xl px-7 py-8">
            {/* Header */}
            <div className="flex flex-col items-center gap-1 mb-6">
              <KortixLogo size={24} />
              <p className="text-[11px] text-foreground/30 tracking-[0.2em] uppercase mt-3">
                Authorize Device
              </p>
            </div>

            {/* Device code hero */}
            <div className="flex items-center justify-between rounded-2xl bg-foreground/[0.04] border border-foreground/[0.06] px-4 py-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="size-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="font-mono text-lg font-medium tracking-[0.15em]">
                  {info.deviceCode}
                </span>
              </div>
              <span className="text-xs text-foreground/30 tabular-nums font-mono">
                {minutes}:{seconds.toString().padStart(2, '0')}
              </span>
            </div>

            {/* Machine info */}
            {info.machineHostname && (
              <div className="flex items-center gap-2 text-[13px] text-foreground/40 mb-5">
                <Monitor className="h-3.5 w-3.5" />
                <span>{info.machineHostname}</span>
              </div>
            )}

            {/* Connection name */}
            <div className="mb-5">
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={info.machineHostname || 'Connection name'}
              />
            </div>

            {/* Divider */}
            <div className="relative mb-4">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-foreground/[0.06]" />
              </div>
              <div className="relative flex justify-center">
                <span className="px-3 bg-background/80 dark:bg-background/75 text-[10px] text-foreground/20 tracking-[0.15em] uppercase">
                  Permissions
                </span>
              </div>
            </div>

            {/* Capabilities */}
            <div className="space-y-1 mb-6">
              {CAPABILITY_REGISTRY.filter((cap) => cap.key === 'filesystem' || cap.key === 'shell').map((cap) => {
                const Icon = cap.icon;
                const selected = selectedCaps.has(cap.key);
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => toggleCap(cap.key)}
                    className={cn(
                      'flex items-center gap-3 w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                      selected
                        ? 'bg-foreground/[0.06]'
                        : 'hover:bg-foreground/[0.03]',
                    )}
                  >
                    <div className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border-[1.5px] transition-colors',
                      selected
                        ? 'border-foreground bg-foreground'
                        : 'border-foreground/20',
                    )}>
                      {selected && <Check className="h-3 w-3 text-background" />}
                    </div>
                    <Icon className={cn('h-4 w-4 shrink-0', selected ? 'text-foreground/70' : 'text-foreground/25')} />
                    <div className="flex-1 min-w-0">
                      <span className={cn('text-[13px]', selected ? 'text-foreground/80' : 'text-foreground/40')}>
                        {cap.label}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <Button
                size="lg"
                className="w-full text-[13px] font-medium"
                onClick={handleApprove}
                disabled={approve.isPending || deny.isPending}
              >
                {approve.isPending ? 'Authorizing...' : 'Approve Connection'}
              </Button>
              <button
                onClick={handleDeny}
                disabled={deny.isPending || approve.isPending}
                className="w-full text-xs text-foreground/30 hover:text-foreground/50 transition-colors py-2"
              >
                Deny request
              </button>
            </div>
          </div>

          {/* Footer hint */}
          <p className="text-[11px] text-center text-foreground/20 mt-4">
            Confirm the code above matches your terminal.
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusScreen({
  icon,
  iconClassName,
  title,
  description,
}: {
  icon: React.ReactNode;
  iconClassName?: string;
  title: string;
  description: string;
}) {
  return (
    <div className="fixed inset-0">
      <WallpaperBackground />
      <div className="relative z-10 flex flex-col items-center justify-center h-full px-4 gap-6">
        <KortixLogo size={28} />
        <div className={cn(
          'flex h-14 w-14 items-center justify-center rounded-full border',
          iconClassName || 'bg-foreground/[0.06] border-foreground/[0.08]',
        )}>
          {icon}
        </div>
        <div className="text-center space-y-1">
          <h1 className="text-[28px] font-extralight tracking-tight text-foreground/80">
            {title}
          </h1>
          <p className="text-sm text-foreground/50 max-w-[280px]">
            {description}
          </p>
        </div>
      </div>
    </div>
  );
}

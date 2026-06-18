'use client';

import { useTranslations } from 'next-intl';

import { KortixLogo } from '@/components/sidebar/kortix-logo';
import { CAPABILITY_REGISTRY } from '@/components/tunnel/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KortixLoader } from '@/components/ui/kortix-loader';
import { WallpaperBackground } from '@/components/ui/wallpaper-background';
import { useAuth } from '@/features/providers/auth-provider';
import {
  useApproveDeviceAuth,
  useDenyDeviceAuth,
  useDeviceAuthInfo,
} from '@/hooks/tunnel/use-tunnel';
import { cn } from '@/lib/utils';
import { Check, Clock, Monitor, X } from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

const EXPIRED_STATUS_ICON_CLASS = 'bg-amber-500/10 border-amber-500/20';

export default function DeviceAuthorizePage() {
  return (
    <Suspense
      fallback={
        <div className="bg-background fixed inset-0 flex items-center justify-center">
          <KortixLoader size="medium" />
        </div>
      }
    >
      <DeviceAuthorize />
    </Suspense>
  );
}

function DeviceAuthorize() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const params = useParams();
  const router = useRouter();
  const code = params.code as string;
  const { user, isLoading: authLoading } = useAuth();

  const { data: info, isLoading, error } = useDeviceAuthInfo(code);
  const approve = useApproveDeviceAuth();
  const deny = useDenyDeviceAuth();

  const [name, setName] = useState('');
  const [selectedCaps, setSelectedCaps] = useState<Set<string>>(new Set(['filesystem', 'shell']));
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
      <div className="bg-background fixed inset-0 flex items-center justify-center">
        <KortixLoader size="medium" />
      </div>
    );
  }

  // ── Not found ──
  if (error || !info) {
    return (
      <StatusScreen
        icon={<X className="text-foreground/50 h-6 w-6" />}
        title={tHardcodedUi.raw('appTunnelAuthorizeCodePage.line113JsxAttrTitleRequestNotFound')}
        description={tHardcodedUi.raw(
          'appTunnelAuthorizeCodePage.line114JsxAttrDescriptionThisAuthorizationRequestDoesnTExistOrHas',
        )}
      />
    );
  }

  // ── Expired ──
  if (info.status === 'expired' || remaining <= 0) {
    return (
      <StatusScreen
        icon={<Clock className="h-6 w-6 text-amber-600 dark:text-amber-400" />}
        iconClassName={EXPIRED_STATUS_ICON_CLASS}
        title={tHardcodedUi.raw('appTunnelAuthorizeCodePage.line125JsxAttrTitleRequestExpired')}
        description={tHardcodedUi.raw(
          'appTunnelAuthorizeCodePage.line126JsxAttrDescriptionThisAuthorizationRequestHasExpiredRunTheConnect',
        )}
      />
    );
  }

  // ── Done (approved / denied) ──
  if (info.status !== 'pending' || done) {
    const isApproved = done === 'approved' || info.status === 'approved';
    return (
      <StatusScreen
        icon={
          isApproved ? (
            <Check className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <X className="text-destructive h-6 w-6" />
          )
        }
        iconClassName={
          isApproved
            ? 'bg-emerald-500/10 border-emerald-500/20'
            : 'bg-destructive/10 border-destructive/20'
        }
        title={isApproved ? 'Device Authorized' : 'Request Denied'}
        description={
          isApproved
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

      <div className="bg-background/20 absolute inset-0 backdrop-blur-[2px]" />

      <div className="relative z-10 flex h-full flex-col items-center justify-center px-4">
        <div className="w-full max-w-[380px]">
          <div className="bg-background/80 dark:bg-background/75 border-foreground/[0.06] rounded-2xl border px-7 py-8 backdrop-blur-2xl">
            {/* Header */}
            <div className="mb-6 flex flex-col items-center gap-1">
              <KortixLogo size={24} />
              <p className="text-foreground/30 mt-3 text-xs tracking-[0.2em] uppercase">
                {tHardcodedUi.raw('appTunnelAuthorizeCodePage.line167JsxTextAuthorizeDevice')}
              </p>
            </div>

            {/* Device code hero */}
            <div className="bg-foreground/[0.04] border-foreground/[0.06] mb-6 flex items-center justify-between rounded-2xl border px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="size-2 animate-pulse rounded-full bg-amber-500" />
                <span className="font-mono text-lg font-medium tracking-[0.15em]">
                  {info.deviceCode}
                </span>
              </div>
              <span className="text-foreground/30 font-mono text-xs tabular-nums">
                {minutes}:{seconds.toString().padStart(2, '0')}
              </span>
            </div>

            {/* Machine info */}
            {info.machineHostname && (
              <div className="text-foreground/40 mb-5 flex items-center gap-2 text-sm">
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
                <div className="border-foreground/[0.06] w-full border-t" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-background/80 dark:bg-background/75 text-foreground/20 px-3 text-xs tracking-[0.15em] uppercase">
                  Permissions
                </span>
              </div>
            </div>

            {/* Capabilities */}
            <div className="mb-6 space-y-1">
              {CAPABILITY_REGISTRY.filter(
                (cap) => cap.key === 'filesystem' || cap.key === 'shell',
              ).map((cap) => {
                const Icon = cap.icon;
                const selected = selectedCaps.has(cap.key);
                return (
                  <button
                    key={cap.key}
                    type="button"
                    onClick={() => toggleCap(cap.key)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                      selected ? 'bg-foreground/[0.06]' : 'hover:bg-foreground/[0.03]',
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border-[1.5px] transition-colors',
                        selected ? 'border-foreground bg-foreground' : 'border-foreground/20',
                      )}
                    >
                      {selected && <Check className="text-background h-3 w-3" />}
                    </div>
                    <Icon
                      className={cn(
                        'h-4 w-4 shrink-0',
                        selected ? 'text-foreground/70' : 'text-foreground/25',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'text-sm',
                          selected ? 'text-foreground/80' : 'text-foreground/40',
                        )}
                      >
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
                className="w-full text-sm font-medium"
                onClick={handleApprove}
                disabled={approve.isPending || deny.isPending}
              >
                {approve.isPending ? 'Authorizing...' : 'Approve Connection'}
              </Button>
              <button
                onClick={handleDeny}
                disabled={deny.isPending || approve.isPending}
                className="text-foreground/30 hover:text-foreground/50 w-full py-2 text-xs transition-colors"
              >
                {tHardcodedUi.raw('appTunnelAuthorizeCodePage.line265JsxTextDenyRequest')}
              </button>
            </div>
          </div>

          {/* Footer hint */}
          <p className="text-foreground/20 mt-4 text-center text-xs">
            {tHardcodedUi.raw(
              'appTunnelAuthorizeCodePage.line272JsxTextConfirmTheCodeAboveMatchesYourTerminal',
            )}
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
      <div className="relative z-10 flex h-full flex-col items-center justify-center gap-6 px-4">
        <KortixLogo size={28} />
        <div
          className={cn(
            'flex h-14 w-14 items-center justify-center rounded-full border',
            iconClassName || 'bg-foreground/[0.06] border-foreground/[0.08]',
          )}
        >
          {icon}
        </div>
        <div className="space-y-1 text-center">
          <h1 className="text-foreground/80 text-3xl font-extralight tracking-tight">{title}</h1>
          <p className="text-foreground/50 max-w-[280px] text-sm">{description}</p>
        </div>
      </div>
    </div>
  );
}

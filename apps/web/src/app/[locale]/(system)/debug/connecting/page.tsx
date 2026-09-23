'use client';

import { useTranslations } from '@/i18n/use-translations';

import type { Stage } from '@/components/dashboard/connecting-screen';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { useEffect, useMemo, useState } from 'react';

/**
 * /debug/connecting
 *
 * A visual harness for inspecting every variant of the canonical
 * `ConnectingScreen` component in isolation — outside any dashboard
 * gating, so you can stare at the screen as long as you want.
 *
 * Shows a floating control panel on the right; the main viewport renders
 * the ConnectingScreen in the selected variant. Pick a variant, watch
 * animations, check spacing, verify the support footer is visible.
 *
 * Not linked from anywhere in the app — just hit /debug/connecting.
 */

type Variant =
  | 'connecting'
  | 'connecting-stage-auth'
  | 'connecting-stage-routing'
  | 'connecting-stage-reaching'
  | 'connecting-stage-restoring'
  | 'connecting-with-title'
  | 'minimal-signing-in'
  | 'minimal-authorizing'
  | 'minimal-no-title'
  | 'provisioning-0'
  | 'provisioning-animated'
  | 'provisioning-with-machine'
  | 'provisioning-with-stages'
  | 'error'
  | 'error-with-location'
  | 'stopped'
  | 'unreachable'
  | 'unreachable-local';

const VARIANTS: { id: Variant; label: string; group: string }[] = [
  { group: 'Connecting', id: 'connecting', label: 'Default (instance name)' },
  { group: 'Connecting', id: 'connecting-with-title', label: 'With title override' },
  { group: 'Connecting', id: 'connecting-stage-auth', label: 'Stage: Authenticating' },
  { group: 'Connecting', id: 'connecting-stage-routing', label: 'Stage: Connecting' },
  { group: 'Connecting', id: 'connecting-stage-reaching', label: 'Stage: Reaching workspace' },
  { group: 'Connecting', id: 'connecting-stage-restoring', label: 'Stage: Restoring session' },

  { group: 'Minimal (auth)', id: 'minimal-signing-in', label: '"Signing in"' },
  { group: 'Minimal (auth)', id: 'minimal-authorizing', label: '"Authorizing"' },
  { group: 'Minimal (auth)', id: 'minimal-no-title', label: 'No title (just logo + bar)' },

  { group: 'Provisioning', id: 'provisioning-0', label: '0% — fresh boot' },
  { group: 'Provisioning', id: 'provisioning-animated', label: 'Animated (auto-progress)' },
  { group: 'Provisioning', id: 'provisioning-with-machine', label: 'With machine info' },
  { group: 'Provisioning', id: 'provisioning-with-stages', label: 'With stage dots' },

  { group: 'Error', id: 'error', label: 'Plain' },
  { group: 'Error', id: 'error-with-location', label: 'With server type + location' },

  { group: 'Stopped', id: 'stopped', label: 'Stopped instance' },

  { group: 'Unreachable', id: 'unreachable', label: 'Cloud' },
];

export default function DebugConnectingPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [variant, setVariant] = useState<Variant>('connecting');
  const [animatedPct, setAnimatedPct] = useState(0);

  // Auto-animate the provisioning progress so you can see the transition.
  useEffect(() => {
    if (variant !== 'provisioning-animated') return;
    setAnimatedPct(0);
    const id = setInterval(() => {
      setAnimatedPct((p) => (p >= 100 ? 0 : p + 3));
    }, 200);
    return () => clearInterval(id);
  }, [variant]);

  const screen = useMemo(
    () => renderVariant(variant, animatedPct, tHardcodedUi),
    [variant, animatedPct, tHardcodedUi],
  );

  const groups = Array.from(new Set(VARIANTS.map((v) => v.group)));

  return (
    <>
      {screen}

      {/* Control panel — fixed, out of the way of the centered content */}
      <div className="border-border/50 bg-background/95 pointer-events-auto fixed top-5 right-5 z-[100] w-[260px] overflow-hidden rounded-2xl border shadow-2xl shadow-black/20 backdrop-blur-xl">
        <div className="border-border/40 border-b px-4 py-3">
          <p className="text-muted-foreground/60 text-xs font-medium tracking-[0.18em] uppercase">
            {tHardcodedUi.raw('appDebugConnectingPage.line93JsxTextConnectingScreen')}
          </p>
          <p className="text-foreground mt-0.5 text-sm font-medium">
            {tHardcodedUi.raw('appDebugConnectingPage.line96JsxTextDebugHarness')}
          </p>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-2">
          {groups.map((group) => (
            <div key={group} className="mb-2 last:mb-0">
              <p className="text-muted-foreground/45 px-2 pt-2 pb-1 text-xs font-semibold tracking-[0.15em] uppercase">
                {group}
              </p>
              {VARIANTS.filter((v) => v.group === group).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariant(v.id)}
                  className={
                    'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ' +
                    (variant === v.id
                      ? 'bg-foreground/[0.06] text-foreground'
                      : 'text-muted-foreground/70 hover:bg-foreground/[0.03] hover:text-foreground/90')
                  }
                >
                  <span
                    className={
                      'h-1.5 w-1.5 shrink-0 rounded-full transition-colors ' +
                      (variant === v.id ? 'bg-foreground/80' : 'bg-foreground/15')
                    }
                  />
                  <span className="truncate">{v.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="border-border/40 border-t px-4 py-3">
          <p className="text-muted-foreground/50 text-xs leading-relaxed">
            {tHardcodedUi.raw('appDebugConnectingPage.line135JsxTextNotLinkedFromTheAppVisit')}{' '}
            <code className="bg-foreground/[0.06] rounded px-1 font-mono text-xs">
              /debug/connecting
            </code>{' '}
            {tHardcodedUi.raw('appDebugConnectingPage.line139JsxTextAnyTime')}
          </p>
        </div>
      </div>
    </>
  );
}

function renderVariant(
  variant: Variant,
  animatedPct: number,
  tHardcodedUi: ReturnType<typeof useTranslations>,
): React.ReactNode {
  const MOCK_STAGES = [
    {
      id: 'server_creating',
      progress: 5,
      message: tHardcodedUi.raw('i18nComplete.text27bcbc3624db'),
    },
    {
      id: 'cloud_init_running',
      progress: 35,
      message: tHardcodedUi.raw('i18nComplete.texta6a8f4387a75'),
    },
    {
      id: 'services_starting',
      progress: 60,
      message: tHardcodedUi.raw('i18nComplete.text688ed737c588'),
    },
    {
      id: 'services_ready',
      progress: 85,
      message: tHardcodedUi.raw('i18nComplete.text3f4bc921bd3a'),
    },
    { id: 'connecting', progress: 98, message: tHardcodedUi.raw('i18nComplete.textc25c44464d12') },
  ];

  const MOCK_MACHINE = {
    ip: '203.0.113.42',
    serverType: 'cpx21',
    location: 'hil',
  };

  switch (variant) {
    case 'connecting':
      return <ConnectingScreen forceConnecting labelOverride="sandbox-83e1c69c-3" />;
    case 'connecting-with-title':
      return (
        <ConnectingScreen
          forceConnecting
          title={tHardcodedUi.raw('appDebugConnectingPage.line171JsxAttrTitleOpeningWorkspace')}
          labelOverride="sandbox-83e1c69c-3"
        />
      );
    case 'connecting-stage-auth':
      return <ConnectingScreen forceConnecting overrideStage={'auth' as Stage} />;
    case 'connecting-stage-routing':
      return <ConnectingScreen forceConnecting overrideStage={'routing' as Stage} />;
    case 'connecting-stage-reaching':
      return <ConnectingScreen forceConnecting overrideStage={'reaching' as Stage} />;
    case 'connecting-stage-restoring':
      return <ConnectingScreen forceConnecting overrideStage={'restoring' as Stage} />;

    case 'minimal-signing-in':
      return (
        <ConnectingScreen
          forceConnecting
          minimal
          title={tHardcodedUi.raw('appDebugConnectingPage.line185JsxAttrTitleSigningIn')}
        />
      );
    case 'minimal-authorizing':
      return (
        <ConnectingScreen
          forceConnecting
          minimal
          title={tHardcodedUi.raw('appCliAuthorizePage.line249JsxTextAuthorizing')}
        />
      );
    case 'minimal-no-title':
      return <ConnectingScreen forceConnecting minimal />;

    case 'provisioning-0':
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          title={tHardcodedUi.raw(
            'appDebugConnectingPage.line195JsxAttrTitleProvisioningWorkspace',
          )}
          provisioning={{
            progress: 0,
            stageLabel: tHardcodedUi.raw('i18nComplete.texta9558a530537'),
          }}
        />
      );
    case 'provisioning-animated':
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          title={tHardcodedUi.raw(
            'appDebugConnectingPage.line206JsxAttrTitleProvisioningWorkspace',
          )}
          provisioning={{
            progress: animatedPct,
            stageLabel:
              animatedPct < 25
                ? tHardcodedUi.raw('i18nComplete.text27bcbc3624db')
                : animatedPct < 50
                  ? tHardcodedUi.raw('i18nComplete.texta6a8f4387a75')
                  : animatedPct < 75
                    ? tHardcodedUi.raw('i18nComplete.text688ed737c588')
                    : 'Finalizing',
          }}
        />
      );
    case 'provisioning-with-machine':
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          title={tHardcodedUi.raw(
            'appDebugConnectingPage.line224JsxAttrTitleProvisioningWorkspace',
          )}
          provisioning={{
            progress: 42,
            stageLabel: tHardcodedUi.raw('i18nComplete.textce3b4016393e'),
            machineInfo: MOCK_MACHINE,
          }}
        />
      );
    case 'provisioning-with-stages':
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          title={tHardcodedUi.raw(
            'appDebugConnectingPage.line236JsxAttrTitleProvisioningWorkspace',
          )}
          provisioning={{
            progress: 60,
            stages: MOCK_STAGES,
            currentStage: 'services_starting',
            machineInfo: MOCK_MACHINE,
          }}
        />
      );

    case 'error':
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          error={{
            message: tHardcodedUi.raw('i18nComplete.text4dde127923ec'),
          }}
        />
      );
    case 'error-with-location':
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          error={{
            message: tHardcodedUi.raw('i18nComplete.text7469c60783db'),
            serverType: 'cpx21',
            location: 'hil',
          }}
        />
      );

    case 'stopped':
      return <ConnectingScreen stopped={{ name: 'sandbox-83e1c69c-3' }} />;

    case 'unreachable':
      // Simulate unreachable by rendering with provisioning? No — we need the
      // store-driven view. The component reads from the sandbox connection
      // store for that. We approximate by synthesizing a labelOverride and
      // forcing the error view with a connection-flavored message, since
      // touching the store here would affect the real app.
      return (
        <ConnectingScreen
          labelOverride="sandbox-83e1c69c-3"
          error={{
            message: tHardcodedUi.raw('i18nComplete.textb931b468ad1a'),
          }}
        />
      );
  }
}

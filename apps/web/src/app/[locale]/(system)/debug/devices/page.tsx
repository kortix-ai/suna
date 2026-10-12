'use client';

/**
 * Visual harness for Settings → Security → Devices. Auth-free: every state is
 * the pure `DevicesSection` fed fixture rows, so no sign-in and no API call.
 * Rows go through the same `describeUserAgent` the container uses, so a label
 * here is the label a real user agent gets. Open /debug/devices.
 */
import type { ReactNode } from 'react';

import { useCopy } from '@/hooks/use-copy';

import { describeUserAgent } from '@/features/workspace/settings/tabs/device-label';
import {
  DEFAULT_SECURITY_TAB_COPY,
  type DeviceRow,
  DevicesSection,
  type DevicesSectionProps,
} from '@/features/workspace/settings/tabs/security-tab';

/** The section exactly as Settings renders it, with the default English copy. */
function Devices(props: Omit<DevicesSectionProps, 'copy'>) {
  const { copy } = useCopy({ successMessage: 'IP address copied' });
  return (
    <DevicesSection
      {...props}
      onCopyIp={(ip) => void copy(ip)}
      copy={DEFAULT_SECURITY_TAB_COPY}
    />
  );
}

const UA = {
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:156.0) Gecko/20100101 Firefox/156.0',
  safariIpad:
    'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/604.1',
  desktopApp:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kortix/1.4.0 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  linuxOther: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Konqueror/5',
  script: 'Bun/1.3.14',
  none: null,
};

/** One fixture row, labelled exactly the way the container labels it. */
function device(
  id: string,
  userAgent: string | null,
  detail: string,
  ip: string | null = null,
  current = false,
): DeviceRow {
  const { browser, os, mobile, brand } = describeUserAgent(userAgent);
  const label = browser && os ? `${browser} on ${os}` : (browser ?? os ?? 'Unknown device');
  return { id, label, detail, ip, mobile, brand, current };
}

const THIS_BROWSER = device('d-here', UA.chromeMac, 'Signed in October 5, 2026', '203.0.113.10', true);

const SCENARIOS: { title: string; note: string; view: ReactNode }[] = [
  {
    title: 'One device',
    note: 'Signed in only here. The bulk action has nothing to sign out but stays visible.',
    view: <Devices devices={[THIS_BROWSER]} />,
  },
  {
    title: 'Two devices',
    note: 'This browser plus a phone.',
    view: (
      <Devices
        devices={[
          THIS_BROWSER,
          device('d-phone', UA.safariIphone, 'Last active Oct 5, 2026, 9:12 PM', '198.51.100.24'),
        ]}
      />
    ),
  },
  {
    title: 'Many devices',
    note: 'Every user-agent family the label helper names, most recently active first.',
    view: (
      <Devices
        devices={[
          THIS_BROWSER,
          device('d-phone', UA.safariIphone, 'Last active Oct 5, 2026, 9:12 PM', '198.51.100.24'),
          device('d-win', UA.edgeWindows, 'Last active Oct 5, 2026, 6:40 PM', '192.0.2.77'),
          device('d-app', UA.desktopApp, 'Last active Oct 4, 2026, 11:03 AM', '203.0.113.10'),
          device('d-android', UA.chromeAndroid, 'Last active Oct 3, 2026, 8:55 PM', '198.51.100.150'),
          device('d-ipad', UA.safariIpad, 'Last active Oct 1, 2026, 7:20 AM', '198.51.100.24'),
          device('d-linux', UA.firefoxLinux, 'Last active Sep 28, 2026, 4:02 PM', '192.0.2.9'),
          device('d-crbook', UA.chromebook, 'Last active Sep 20, 2026, 1:15 PM', '192.0.2.200'),
        ]}
      />
    ),
  },
  {
    title: 'Unrecognised devices',
    note: 'A browser with no logo on Linux (the system mark), a script (product token only), and a sign-in that recorded no user agent.',
    view: (
      <Devices
        devices={[
          THIS_BROWSER,
          device('d-tux', UA.linuxOther, 'Last active Oct 5, 2026, 3:48 PM', '192.0.2.41'),
          device('d-script', UA.script, 'Last active Oct 5, 2026, 2:22 PM', '203.0.113.10'),
          device('d-none', UA.none, 'Last active Oct 2, 2026, 10:00 AM'),
        ]}
      />
    ),
  },
  {
    title: 'Signing out one device',
    note: 'The phone sign-out is in flight: its button spins, every per-device button is disabled.',
    view: (
      <Devices
        devices={[
          THIS_BROWSER,
          device('d-phone', UA.safariIphone, 'Last active Oct 5, 2026, 9:12 PM', '198.51.100.24'),
          device('d-win', UA.edgeWindows, 'Last active Oct 5, 2026, 6:40 PM', '192.0.2.77'),
        ]}
        signingOutDeviceId="d-phone"
      />
    ),
  },
  {
    title: 'Signing out every other device',
    note: 'The bulk action is in flight.',
    view: (
      <Devices
        devices={[
          THIS_BROWSER,
          device('d-phone', UA.safariIphone, 'Last active Oct 5, 2026, 9:12 PM', '198.51.100.24'),
        ]}
        isSigningOutOtherDevices
      />
    ),
  },
  {
    title: 'Long text',
    note: 'A long label and detail truncate instead of pushing the action off the row.',
    view: (
      <Devices
        devices={[
          THIS_BROWSER,
          {
            id: 'd-long',
            label: 'Kortix desktop on a very long operating system name that keeps going',
            detail: 'Last active Oct 5, 2026, 9:12 PM',
            ip: '2001:db8:85a3:0000:0000:8a2e:0370:7334',
          },
        ]}
      />
    ),
  },
  { title: 'Loading', note: 'The list is in flight.', view: <Devices devicesLoading /> },
  { title: 'Load failed', note: 'The list request failed.', view: <Devices devicesError /> },
  { title: 'No devices', note: 'The API answered with an empty list.', view: <Devices /> },
];

export default function DebugDevicesPage() {
  return (
    <main className="bg-background min-h-screen px-6 py-10">
      <div className="mx-auto max-w-3xl space-y-12">
        <header className="space-y-1">
          <h1 className="text-foreground text-xl font-medium">Devices · every state</h1>
          <p className="text-muted-foreground text-sm">
            Settings → Security → Devices, rendered from fixtures with the production component.
          </p>
        </header>
        {SCENARIOS.map((scenario) => (
          <section key={scenario.title} className="space-y-4">
            <div className="border-border space-y-1 border-b pb-2">
              <h2 className="text-foreground text-sm font-medium">{scenario.title}</h2>
              <p className="text-muted-foreground text-xs">{scenario.note}</p>
            </div>
            {scenario.view}
          </section>
        ))}
      </div>
    </main>
  );
}

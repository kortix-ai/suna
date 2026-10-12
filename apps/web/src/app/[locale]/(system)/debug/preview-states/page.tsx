'use client';

import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import type { ShowCarouselItem } from '@/features/file-renderers/show-content-renderer';
import {
  ServicePreviewViewport,
  type ServicePreviewState,
} from '@/features/session/tool/shared/infrastructure-preview';
import { ShowCarouselTabs, showFileTypeIcon } from '@/features/session/tool/shared/show-helpers';
import { ShowUnavailableNote } from '@/features/session/tool/tools/show-tool';
import {
  PREVIEW_BUILDING_STATES,
  previewStatePage,
  type PreviewState,
} from '@kortix/shared/preview-state-page';
import type { ReactNode } from 'react';

/**
 * /debug/preview-states
 *
 * Every state a `show` card for a running port can be in, side by side:
 * the card header (desktop icon or the dot-matrix busy glyph) above the real
 * proxy state page (`previewStatePage`, the exact HTML the API serves).
 *
 * The dot matrix shows only while the app is still building: the sandbox is
 * waking (`starting`) or nothing has bound the port yet (`not-listening`),
 * plus the moment before the frame has loaded anything. `unreachable` and
 * every identity state keep the desktop icon.
 *
 * The frames are sandboxed without same-origin, so the page's auto-retry
 * cannot reach sessionStorage and holds still instead of reloading.
 *
 * Not linked from anywhere — just hit /debug/preview-states.
 */

const PORT = 3000;
const URL = `http://localhost:${PORT}`;
const RETURN_TO = `https://p${PORT}-sbx-demo.localhost:8008/`;

function statePageHtml(state: PreviewState, gaveUp = false): string {
  const html = previewStatePage({
    state,
    port: PORT,
    returnTo: RETURN_TO,
    frontendUrl: typeof window === 'undefined' ? '' : window.location.origin,
  });
  // The give-up branch runs after 40 reloads. Start the counter there.
  return gaveUp
    ? html.replace("var n = parseInt(sessionStorage.getItem(KEY) || '0', 10) || 0;", 'var n = 40;')
    : html;
}

function DotMatrix({ seed }: { seed: string }) {
  return <SessionDotMatrix sessionId={seed} size={14} className="shrink-0" />;
}

function DesktopIcon() {
  return showFileTypeIcon('url', undefined, undefined, URL);
}

/** The inline `show` card chrome, as `ShowTool` draws it. */
function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="bg-secondary flex w-full flex-col overflow-hidden rounded-lg border-[0.5px]">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <div className="text-foreground flex min-w-0 items-center gap-2 px-1 text-xs [&>svg]:size-4">
          {icon}
          <span className="min-w-0 truncate">{title}</span>
        </div>
      </div>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function Frame({ html }: { html: string }) {
  return (
    <iframe
      srcDoc={html}
      sandbox="allow-scripts"
      title="Preview state page"
      className="bg-background block aspect-video w-full border-0"
    />
  );
}

function Case({
  name,
  note,
  busy,
  children,
}: {
  name: string;
  note: string;
  busy: boolean;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-foreground font-mono text-xs">{name}</h2>
        <span className="text-muted-foreground text-xs">
          {busy ? 'Dot matrix' : 'Desktop icon'}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">{note}</p>
      {children}
    </section>
  );
}

const PROXY_CASES: Array<{ state: PreviewState; gaveUp?: boolean; note: string }> = [
  { state: 'starting', note: 'The sandbox is waking. Load line, auto-retry every 3 s.' },
  { state: 'not-listening', note: 'The sandbox is up; nothing has bound the port yet.' },
  {
    state: 'unreachable',
    note: 'Something answered before and stopped. Not building: no busy glyph, Try again.',
  },
  {
    state: 'starting',
    gaveUp: true,
    note: 'After 40 reloads (~2 min) the load line stops and Try again appears.',
  },
  { state: 'signed-out', note: 'No credential yet. Offers sign-in.' },
  { state: 'forbidden', note: 'Host claimed without the edge signature.' },
  { state: 'unknown', note: 'The sandbox behind the address no longer exists.' },
];

const LOADING_PREVIEW = {
  previewUrl: '',
  frameContent: 'app',
  displayLabel: `HTML running on port ${PORT}`,
  isLoading: true,
  hasError: false,
  refreshKey: 0,
  onLoad: () => {},
  onError: () => {},
  frameRef: { current: null },
} as unknown as ServicePreviewState;

const PORT_TABS: ShowCarouselItem[] = [3000, 3001, 3002].map((port) => ({
  type: 'url',
  url: `http://localhost:${port}`,
}));

export default function DebugPreviewStatesPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-10 px-4 py-10">
      <header className="space-y-1">
        <h1 className="text-foreground text-xl font-medium">Preview states</h1>
        <p className="text-muted-foreground text-sm">
          Every state of a port preview in a show card. The dot matrix replaces the desktop icon
          only while the app is building: before the frame loads, starting, and not-listening.
        </p>
      </header>

      <div className="grid gap-8 md:grid-cols-2">
        <Case
          name="frame-loading"
          note="The preview URL is resolving or the frame has not loaded."
          busy
        >
          <Card icon={<DotMatrix seed={URL} />} title={`HTML running on port ${PORT}`}>
            <ServicePreviewViewport preview={LOADING_PREVIEW} />
          </Card>
        </Case>

        {PROXY_CASES.map(({ state, gaveUp, note }) => {
          const busy = PREVIEW_BUILDING_STATES.has(state) && !gaveUp;
          return (
            <Case
              key={`${state}-${gaveUp ? 'gave-up' : 'live'}`}
              name={gaveUp ? `${state} (gave up)` : state}
              note={note}
              busy={busy}
            >
              <Card
                icon={busy ? <DotMatrix seed={URL} /> : <DesktopIcon />}
                title={`HTML running on port ${PORT}`}
              >
                <Frame html={statePageHtml(state, gaveUp)} />
              </Card>
            </Case>
          );
        })}

        <Case name="ready" note="The app answered. The frame shows the app itself." busy={false}>
          <Card icon={<DesktopIcon />} title={`HTML running on port ${PORT}`}>
            <div className="bg-background text-muted-foreground flex aspect-video items-center justify-center text-xs">
              The app’s own page
            </div>
          </Card>
        </Case>

        <Case
          name="unavailable (port)"
          note="The frame failed or timed out after 8 s. The header owns refresh."
          busy={false}
        >
          <Card icon={<DesktopIcon />} title={`HTML running on port ${PORT}`}>
            <ShowUnavailableNote isWebsitePreview href={null} />
          </Card>
        </Case>

        <Case
          name="unavailable (link)"
          note="A plain link that did not load keeps Open link."
          busy={false}
        >
          <Card
            icon={showFileTypeIcon('url', undefined, undefined, 'https://example.com')}
            title="example.com"
          >
            <ShowUnavailableNote isWebsitePreview={false} href="https://example.com" />
          </Card>
        </Case>
      </div>

      <section className="space-y-4">
        <h2 className="text-foreground text-sm font-medium">Port tabs</h2>
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">Building: every port tab shows its glyph.</p>
          <div className="bg-secondary flex items-center rounded-lg border-[0.5px] px-2 py-1.5">
            <ShowCarouselTabs
              items={PORT_TABS}
              activeIndex={0}
              onSelect={() => {}}
              tabIcon={(item) => <DotMatrix seed={item.url || ''} />}
            />
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            Ready, unreachable or unavailable: desktop icons.
          </p>
          <div className="bg-secondary flex items-center rounded-lg border-[0.5px] px-2 py-1.5">
            <ShowCarouselTabs items={PORT_TABS} activeIndex={0} onSelect={() => {}} />
          </div>
        </div>
      </section>
    </div>
  );
}

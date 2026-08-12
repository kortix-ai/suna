import type { SandboxTemplate } from '@kortix/sdk';
import { CpuIcon, PackageIcon } from '@phosphor-icons/react';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  type ProviderCoverageEntry,
  describeProviderCoverage,
  describeProviderMode,
  latestObservedAt,
  sandboxProviderLabel,
} from '../../customize/sections/view/sandbox-provider-coverage';
import {
  SandboxTabView,
  TemplateFact,
  TemplateRuntimeFooter,
  TemplateStateLine,
  describeBase,
  describeRouting,
  describeSource,
  describeState,
} from './sandbox-tab';

/**
 * Carries forward ALL of `sandbox-provider-coverage.test.tsx`'s coverage
 * (deleted — see Task 20's brief) — same assertions, same import path
 * (`sandbox-provider-coverage.tsx` itself did not move, only its test did,
 * since `SandboxTemplateProviderCoverage`/`SandboxTemplateProviderModeBadge`
 * are Sandbox-half symbols per JAY-508, used only by this tab's
 * `TemplateRow`).
 */
const coverageEntry = (
  overrides: Partial<ProviderCoverageEntry> & Pick<ProviderCoverageEntry, 'provider'>,
): ProviderCoverageEntry => {
  const { provider, ...rest } = overrides;

  return {
    provider,
    available: true,
    snapshot_name: `${provider}-snapshot`,
    state: 'active',
    status: 'ready',
    launch_ready: true,
    observed_at: '2026-07-14T10:00:00.000Z',
    ...rest,
  };
};

/**
 * Retargeted at `TemplateRuntimeFooter`, the component that now ships.
 * `SandboxTemplateProviderCoverage` and `SandboxTemplateProviderModeBadge`
 * were pre-composed rows that forced the card to nest a labelled row inside
 * another labelled row; the footer owns its own layout now and the mode badge
 * became the grid's "Routing" fact. Every assertion below is carried forward —
 * the ones about routing words simply moved to `describeRouting`.
 */
function renderProviderPresentation({
  providerMode,
  coverage,
  selectedProvider,
}: {
  providerMode: 'automatic' | 'pinned';
  coverage: ProviderCoverageEntry[];
  selectedProvider: ProviderCoverageEntry['provider'] | null;
}) {
  return renderToStaticMarkup(
    createElement(TemplateRuntimeFooter, {
      providerMode,
      coverage,
      selectedProvider,
      formatObservedAt: () => 'now',
    }),
  );
}

describe('sandbox template provider coverage presentation', () => {
  test('uses explicit launch-readiness language for every provider state', () => {
    expect(describeProviderCoverage('ready')).toEqual({ label: 'Ready', tone: 'ok' });
    expect(describeProviderCoverage('building')).toEqual({ label: 'Building', tone: 'busy' });
    expect(describeProviderCoverage('failed')).toEqual({ label: 'Failed', tone: 'fail' });
    expect(describeProviderCoverage('not_built')).toEqual({
      label: 'Not ready',
      tone: 'idle',
    });
    expect(describeProviderCoverage('unavailable')).toEqual({ label: 'Unavailable', tone: 'idle' });
    expect(describeProviderCoverage('unknown')).toEqual({ label: 'Unknown', tone: 'idle' });
  });

  test('keeps Automatic and Pinned badges neutral while preserving selected metadata', () => {
    expect(describeProviderMode('automatic', 'daytona')).toEqual({
      label: 'Automatic',
      selectedProvider: null,
    });
    expect(describeProviderMode('pinned', 'e2b')).toEqual({
      label: 'Pinned provider',
      selectedProvider: 'E2B',
    });
    expect(sandboxProviderLabel('e2b')).toBe('E2B');
  });

  test('renders automatic mode with runtime readiness for every routed provider', () => {
    const html = renderProviderPresentation({
      providerMode: 'automatic',
      selectedProvider: 'daytona',
      coverage: [
        coverageEntry({ provider: 'daytona', status: 'ready' }),
        coverageEntry({ provider: 'platinum', status: 'building' }),
        coverageEntry({ provider: 'e2b', available: false, status: 'unavailable' }),
      ],
    });

    expect(html).toContain('Session runtime');
    expect(html).toContain('Daytona');
    expect(html).toContain('Platinum');
    expect(html).not.toContain('E2B');
    expect(html).toContain('Ready');
    expect(html).toContain('Building');
    expect(html).not.toContain('Selected');
    // "Automatic" is routing configuration, not live status — it is a labelled
    // grid fact now, so it must NOT reappear as a bare badge in this strip.
    expect(html).not.toContain('Automatic');
    expect(describeRouting('automatic', 'daytona').label).toBe('Automatic');
  });

  test('the footer keeps its stamp separable so it can be pushed to the far edge', () => {
    // The old composite baked label + badges + timestamp into one flex block,
    // so the stamp could never be positioned by the caller. `ml-auto` is only
    // reachable because the stamp is a direct child of the footer row.
    const html = renderProviderPresentation({
      providerMode: 'automatic',
      selectedProvider: null,
      coverage: [coverageEntry({ provider: 'daytona', status: 'ready' })],
    });
    expect(html).toContain('ml-auto');
    expect(html).toContain('Checked now');
    // No observation reported → no stamp at all, rather than "Checked —".
    const noStamp = renderProviderPresentation({
      providerMode: 'automatic',
      selectedProvider: null,
      coverage: [coverageEntry({ provider: 'daytona', status: 'ready', observed_at: null })],
    });
    expect(noStamp).not.toContain('Checked');
    expect(latestObservedAt([coverageEntry({ provider: 'daytona', observed_at: null })])).toBeNull();
  });

  test('renders pinned matrix with only available providers and their states', () => {
    const html = renderProviderPresentation({
      providerMode: 'pinned',
      selectedProvider: 'daytona',
      coverage: [
        coverageEntry({ provider: 'daytona', available: true, status: 'ready' }),
        coverageEntry({ provider: 'platinum', available: false, status: 'ready' }),
        coverageEntry({
          provider: 'e2b',
          available: true,
          status: 'building',
          state: 'building',
          launch_ready: false,
        }),
      ],
    });

    expect(html).toContain('Session runtime');
    expect(html).toContain('Daytona');
    expect(html).toContain('Ready');
    expect(html).toContain('E2B');
    expect(html).toContain('Building');
    expect(html).not.toContain('Platinum');
    expect(html).not.toContain('Pinned provider');
  });

  test('pinned with no available providers renders no runtime strip at all', () => {
    const html = renderProviderPresentation({
      providerMode: 'pinned',
      selectedProvider: 'e2b',
      coverage: [
        coverageEntry({ provider: 'daytona', available: false, status: 'unavailable' }),
        coverageEntry({ provider: 'platinum', available: false, status: 'unavailable' }),
        coverageEntry({ provider: 'e2b', available: false, status: 'unavailable' }),
      ],
    });

    // Previously this case produced a lone "Pinned provider" badge floating in
    // the strip with no label beside it. The card now ends at the spec grid,
    // and the routing fact carries the words — with the pinned provider named.
    expect(html).toBe('');
    expect(describeRouting('pinned', 'e2b').label).toBe('Pinned · E2B');
    expect(describeRouting('pinned', null).label).toBe('Pinned');
  });

  test('routing is stated as a labelled fact, never a bare unlabelled badge', () => {
    expect(describeRouting('automatic', null).label).toBe('Automatic');
    expect(describeRouting('automatic', 'daytona').label).toBe('Automatic');
    expect(describeRouting('pinned', 'platinum').label).toBe('Pinned · Platinum');
    // Distinct glyph per mode so the two are separable at a glance.
    expect(describeRouting('automatic', null).icon).not.toBe(describeRouting('pinned', null).icon);
  });
});

/**
 * `SandboxTabView` — the pure half of the split. `templatesSlot` is a slot
 * (see this tab's header comment for why `TemplateRow` can't render under
 * `renderToStaticMarkup`); these tests pin everything the pure view DOES
 * own directly: loading/error/empty states, the manifest hint, and that no
 * build-log content ever appears here.
 */
describe('SandboxTabView', () => {
  test('renders the header and the templates slot', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView isEmpty={false} templatesSlot={<li>template-row-marker</li>} />,
    );
    expect(out).toContain('Sandbox templates');
    expect(out).toContain('template-row-marker');
  });

  test('renders the empty state with its action when there are no templates', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView isEmpty emptyAction={<button type="button">new-template-marker</button>} />,
    );
    expect(out).toContain('No templates resolved yet.');
    expect(out).toContain('new-template-marker');
  });

  test('renders the header action when provided', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView headerAction={<button type="button">header-action-marker</button>} />,
    );
    expect(out).toContain('header-action-marker');
  });

  test('reads the manifest hint from kortix.toml by default, kortix.yaml at manifest v2', () => {
    const v1 = renderToStaticMarkup(<SandboxTabView manifestVersion={1} />);
    expect(v1).toContain('kortix.toml');
    expect(v1).not.toContain('kortix.yaml');

    const v2 = renderToStaticMarkup(<SandboxTabView manifestVersion={2} />);
    expect(v2).toContain('kortix.yaml');
    expect(v2).not.toContain('kortix.toml');
  });

  test('surfaces a partial-read warning without failing the whole tab', () => {
    const out = renderToStaticMarkup(<SandboxTabView templatesError="permission denied" />);
    expect(out).toContain('permission denied');
  });

  test('loading state shows a skeleton, not the manifest hint', () => {
    // Pinned to the live lead sentence, not a stale one — a `not.toContain` on
    // copy the component no longer renders passes for the wrong reason and can
    // never fail again. Assert the positive case too so the pairing is real.
    const lead = 'Every session starts from a sandbox template';
    expect(renderToStaticMarkup(<SandboxTabView isEmpty={false} />)).toContain(lead);
    expect(renderToStaticMarkup(<SandboxTabView isLoading />)).not.toContain(lead);
  });

  test('the loading state is flat frames — no skeleton nested inside a skeleton', () => {
    const out = renderToStaticMarkup(<SandboxTabView isLoading />);

    // Exactly three frames...
    expect((out.match(/animate-pulse/g) ?? []).length).toBe(3);
    // ...and every one of them is a LEAF. An empty element between its own
    // tags cannot contain another skeleton, which is the whole complaint: the
    // old placeholder drew a bordered panel and packed six shapes inside it.
    expect((out.match(/<div class="[^"]*animate-pulse[^"]*"><\/div>/g) ?? []).length).toBe(3);
    // No card surface chrome drawn behind them either.
    expect(out).not.toContain('bg-popover');
  });

  test('error state shows a retry action', () => {
    const out = renderToStaticMarkup(<SandboxTabView isError errorMessage="boom" />);
    expect(out).toContain('Retry');
    expect(out).toContain('boom');
  });

  test('renders the templates slot directly, with no divide-y wrapper around it', () => {
    // The card layout carries its own border per `<li>`; a wrapping bordered,
    // divided box would double every seam.
    const out = renderToStaticMarkup(
      <SandboxTabView isEmpty={false} templatesSlot={<ul>{'slot'}</ul>} />,
    );
    expect(out).not.toContain('divide-y');
  });

  test('never renders the build log or its vocabulary — that lives in SnapshotsTabView', () => {
    const out = renderToStaticMarkup(<SandboxTabView isEmpty={false} />);
    expect(out).not.toContain('Session template builds');
    expect(out).not.toContain('Build log');
    expect(out).not.toContain('Project accelerator');
    expect(out).not.toContain('Snapshot quota reached');
    expect(out).not.toContain('Sessions can’t start');
  });
});

/**
 * The readability contract of the template card. `TemplateCard` itself owns
 * `useMutation`/`useQueryClient` and cannot render under
 * `renderToStaticMarkup`, so its presentation decisions live as pure
 * functions/leaf components and are asserted here directly.
 *
 * These guard the two defects the card layout was built to fix — see this
 * tab's header comment. Both survived for as long as they did because nothing
 * asserted the rendered output of the row.
 */
const template = (overrides: Partial<SandboxTemplate> = {}): SandboxTemplate => ({
  template_id: 'tpl_1',
  slug: 'default',
  name: 'Default sandbox',
  is_default: false,
  source: 'toml',
  provider: 'daytona',
  has_dockerfile: false,
  has_image: true,
  image: 'kortixai/sandbox-base:2026.08',
  dockerfile_path: null,
  entrypoint: null,
  cpu: 2,
  memory_gb: 4,
  disk_gb: 20,
  snapshot_name: 'snap-1',
  content_hash: 'abc123',
  built_from_commit: null,
  daytona_state: 'active',
  provider_state: 'active',
  ready: true,
  ...overrides,
});

describe('template card readability', () => {
  test('every provider state resolves to a word, not just a tone', () => {
    expect(describeState('active')).toEqual({ label: 'Ready', tone: 'ok' });
    expect(describeState('pulling')).toEqual({ label: 'Pulling', tone: 'busy' });
    expect(describeState('building')).toEqual({ label: 'Building', tone: 'busy' });
    expect(describeState('removing')).toEqual({ label: 'Removing', tone: 'busy' });
    expect(describeState('error')).toEqual({ label: 'Error', tone: 'fail' });
    expect(describeState('build_failed')).toEqual({ label: 'Build failed', tone: 'fail' });
    expect(describeState('missing')).toEqual({ label: 'Not built yet', tone: 'idle' });
    // Unknown states still surface their raw value rather than rendering blank.
    expect(describeState('teleporting')).toEqual({ label: 'teleporting', tone: 'idle' });
    expect(describeState('')).toEqual({ label: 'Unknown', tone: 'idle' });
  });

  test('status renders the word, so it survives greyscale and colour blindness', () => {
    // The pre-card row computed `describeState(...).label` and threw it away:
    // the ONLY status signal was the icon tile's tint. Assert the word is in
    // the markup for every tone.
    for (const [tone, label] of [
      ['ok', 'Ready'],
      ['busy', 'Building'],
      ['fail', 'Build failed'],
      ['idle', 'Not built yet'],
    ] as const) {
      const out = renderToStaticMarkup(<TemplateStateLine tone={tone} label={label} />);
      expect(out).toContain(label);
    }
  });

  test('each tone renders a distinct glyph alongside its word', () => {
    const glyphOf = (tone: 'ok' | 'busy' | 'fail' | 'idle') =>
      renderToStaticMarkup(<TemplateStateLine tone={tone} label="x" />)
        .replace(/>x</, '><')
        .replace(/class="[^"]*"/g, '');
    const glyphs = (['ok', 'busy', 'fail', 'idle'] as const).map(glyphOf);
    expect(new Set(glyphs).size).toBe(4);
    // `busy` is the live-operation case and must be the codebase's spinner,
    // never a static icon — the tab re-polls every 5s while it shows.
    expect(renderToStaticMarkup(<TemplateStateLine tone="busy" label="Building" />)).toContain(
      'animate-spinner-spokes',
    );
  });

  test('the source tag reads as plain English, not a raw enum', () => {
    expect(describeSource(template({ source: 'platform' }), 2).label).toBe('Kortix platform');
    expect(describeSource(template({ source: 'ui' }), 2).label).toBe('This dashboard');
    expect(describeSource(template({ source: 'toml' }), 2)).toMatchObject({
      label: 'kortix.yaml',
      mono: true,
    });
    expect(describeSource(template({ source: 'toml' }), 1).label).toBe('kortix.toml');
    expect(describeSource(template({ source: 'toml' }), null).label).toBe('kortix.toml');
  });

  test('the base cell states the real image even for the platform default', () => {
    // The pre-card row branched on `is_default` FIRST and rendered
    // "Platform default · shared by every project" instead of the image, so
    // the one template every project boots from never showed what it is.
    expect(describeBase(template({ is_default: true }))).toMatchObject({
      label: 'Base image',
      value: 'kortixai/sandbox-base:2026.08',
      mono: true,
    });
    expect(
      describeBase(
        template({
          has_image: false,
          image: null,
          has_dockerfile: true,
          dockerfile_path: '.kortix/Dockerfile',
        }),
      ),
    ).toMatchObject({ label: 'Built from', value: '.kortix/Dockerfile', mono: true });
    // Neither declared — still a sentence, never an empty cell.
    expect(
      describeBase(template({ has_image: false, image: null, has_dockerfile: false })),
    ).toMatchObject({ label: 'Base image', value: 'Kortix default', mono: false });
  });

  test('the spec grid is six single-track cells — two full rows, no spans', () => {
    // A `col-span-*` cell is what made the grid read as ragged: a uniform
    // three-track grid carrying one double-wide cell beside one narrow one.
    // Six cells fill two complete rows with no holes and nothing spanning.
    const facts = [
      ['Processor', '2 vCPU'],
      ['Memory', '4 GiB'],
      ['Storage', '20 GiB'],
      ['Base image', 'img'],
      ['Defined in', 'kortix.yaml'],
      ['Routing', 'Automatic'],
    ] as const;
    const out = renderToStaticMarkup(
      <dl>
        {facts.map(([label, value]) => (
          <TemplateFact key={label} icon={CpuIcon} label={label} value={value} />
        ))}
      </dl>,
    );
    expect(out.match(/<dt/g)?.length).toBe(6);
    expect(out).not.toContain('col-span');
  });

  test('every spec value carries its own label, and long values truncate in-cell', () => {
    const out = renderToStaticMarkup(
      <dl>
        <TemplateFact icon={CpuIcon} label="Processor" value="2 vCPU" />
        <TemplateFact icon={PackageIcon} label="Base image" value="a/very/long/image:tag" mono />
      </dl>,
    );
    // Label + value are separate elements; the bare "4 GiB means memory, the
    // other GiB means disk" guessing game is gone.
    expect(out).toContain('<dt');
    expect(out).toContain('Processor');
    expect(out).toContain('2 vCPU');
    expect(out).toContain('Base image');
    // Overflow is contained to the cell and recoverable via the native title.
    expect(out).toContain('truncate');
    expect(out).toContain('title="a/very/long/image:tag"');
  });
});

import type { SandboxTemplate } from '@kortix/sdk';
import { CpuIcon, PackageIcon } from '@phosphor-icons/react';
import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FactCell } from './fact-cell';

import { testUiTranslator } from '../../../test-utils/intl';
import {
  type ProviderCoverageEntry,
  describeProviderCoverage,
  latestObservedAt,
} from '../../sections/view/sandbox-provider-coverage';
import {
  SandboxTabView,
  TemplateRuntimeFooter,
  TemplateStateLine,
  describeBase,
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
 * another labelled row; the footer owns its own layout now. The routing mode
 * left with the provider pin: every sandbox runs on Platinum.
 */
function renderProviderPresentation({
  coverage,
  badgeCopy,
  runtimeLabel,
}: {
  coverage: ProviderCoverageEntry[];
  badgeCopy?: Parameters<typeof TemplateRuntimeFooter>[0]['badgeCopy'];
  runtimeLabel?: string;
}) {
  return renderToStaticMarkup(
    createElement(TemplateRuntimeFooter, {
      coverage,
      formatObservedAt: () => 'now',
      runtimeLabel: runtimeLabel ?? 'Session runtime',
      checkedLabel: (value: string) => `Checked ${value}`,
      badgeCopy,
    }),
  );
}

describe('sandbox template provider coverage presentation', () => {
  test('uses explicit launch-readiness language for every provider state', () => {
    expect(describeProviderCoverage('ready', testUiTranslator)).toEqual({
      label: 'Ready',
      tone: 'ok',
    });
    expect(describeProviderCoverage('building', testUiTranslator)).toEqual({
      label: 'Building',
      tone: 'busy',
    });
    expect(describeProviderCoverage('failed', testUiTranslator)).toEqual({
      label: 'Failed',
      tone: 'fail',
    });
    expect(describeProviderCoverage('not_built', testUiTranslator)).toEqual({
      label: 'Not ready',
      tone: 'idle',
    });
    expect(describeProviderCoverage('unavailable', testUiTranslator)).toEqual({
      label: 'Unavailable',
      tone: 'idle',
    });
    expect(describeProviderCoverage('unknown', testUiTranslator)).toEqual({
      label: 'Unknown',
      tone: 'idle',
    });
  });

  test('shows Platinum readiness only: a deprecated provider is never offered', () => {
    const html = renderProviderPresentation({
      coverage: [
        coverageEntry({ provider: 'daytona', status: 'ready' }),
        coverageEntry({ provider: 'platinum', status: 'building' }),
      ],
    });

    expect(html).toContain('Session runtime');
    expect(html).toContain('Platinum');
    expect(html).toContain('Building');
    expect(html).not.toContain('Daytona');
    expect(html).not.toContain('Legacy');
    expect(html).not.toContain('Ready');
    expect(html).not.toContain('Selected');
    expect(html).not.toContain('Automatic');
  });

  test('the footer keeps its stamp separable so it can be pushed to the far edge', () => {
    // The old composite baked label + badges + timestamp into one flex block,
    // so the stamp could never be positioned by the caller. `ml-auto` is only
    // reachable because the stamp is a direct child of the footer row.
    const html = renderProviderPresentation({
      coverage: [coverageEntry({ provider: 'platinum', status: 'ready' })],
    });
    expect(html).toContain('ml-auto');
    expect(html).toContain('Checked now');
    // No observation reported → no stamp at all, rather than "Checked —".
    const noStamp = renderProviderPresentation({
      coverage: [coverageEntry({ provider: 'platinum', status: 'ready', observed_at: null })],
    });
    expect(noStamp).not.toContain('Checked');
    expect(
      latestObservedAt([coverageEntry({ provider: 'platinum', observed_at: null })]),
    ).toBeNull();
  });

  test('renders localized runtime and provider status copy', () => {
    const html = renderProviderPresentation({
      coverage: [coverageEntry({ provider: 'platinum', status: 'ready' })],
      runtimeLabel: 'Окружење сесије',
      badgeCopy: { states: { ready: 'Спремно' } },
    });
    expect(html).toContain('Окружење сесије');
    expect(html).toContain('Спремно');
    expect(html).not.toContain('Ready');
  });

  test('no available Platinum coverage renders no runtime strip at all', () => {
    const html = renderProviderPresentation({
      coverage: [
        coverageEntry({ provider: 'daytona', available: true, status: 'ready' }),
        coverageEntry({ provider: 'platinum', available: false, status: 'unavailable' }),
      ],
    });

    // The card ends at the spec grid: no lone badge floats in an unlabelled strip.
    expect(html).toBe('');
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
  test('renders injected Serbian view copy without an intl provider', () => {
    const out = renderToStaticMarkup(
      <SandboxTabView
        copy={{
          loadFailed: 'Учитавање није успело:',
          retry: 'Покушај поново',
          descriptionStart: 'Свака сесија почиње у',
          descriptionEnd: 'Додајте шаблон као',
          configReadFailed: 'Конфигурација није учитана:',
          emptyTitle: 'Још нема шаблона.',
          emptyDescription: 'Направите шаблон.',
        }}
      />,
    );
    expect(out).toContain('Свака сесија почиње у');
    expect(out).toContain('Још нема шаблона.');
    expect(out).not.toContain('Every session starts');
  });
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

  test('reads the manifest hint from kortix.toml by default, kortix.yaml at manifest v2 and v3', () => {
    const v1 = renderToStaticMarkup(<SandboxTabView manifestVersion={1} />);
    expect(v1).toContain('kortix.toml');
    expect(v1).not.toContain('kortix.yaml');

    for (const version of [2, 3]) {
      const yaml = renderToStaticMarkup(<SandboxTabView manifestVersion={version} />);
      expect(yaml).toContain('kortix.yaml');
      expect(yaml).not.toContain('kortix.toml');
    }
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
  provider: 'platinum',
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
    expect(describeSource(template({ source: 'toml' }), 3).label).toBe('kortix.yaml');
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
          dockerfile_path: 'Dockerfile.sandbox',
        }),
      ),
    ).toMatchObject({ label: 'Built from', value: 'Dockerfile.sandbox', mono: true });
    // Neither declared — still a sentence, never an empty cell.
    expect(
      describeBase(template({ has_image: false, image: null, has_dockerfile: false })),
    ).toMatchObject({ label: 'Base image', value: 'Kortix default', mono: false });
  });

  test('the spec grid is five single-track cells with no spans', () => {
    // A `col-span-*` cell is what made the grid read as ragged: a uniform
    // three-track grid carrying one double-wide cell beside one narrow one.
    // The sixth "Routing" cell left with the provider pin.
    const facts = [
      ['Processor', '2 vCPU'],
      ['Memory', '4 GiB'],
      ['Storage', '20 GiB'],
      ['Base image', 'img'],
      ['Defined in', 'kortix.yaml'],
    ] as const;
    const out = renderToStaticMarkup(
      <dl>
        {facts.map(([label, value]) => (
          <FactCell key={label} icon={CpuIcon} label={label} value={value} />
        ))}
      </dl>,
    );
    expect(out.match(/<dt/g)?.length).toBe(5);
    expect(out).not.toContain('col-span');
  });

  test('every spec value carries its own label, and long values truncate in-cell', () => {
    const out = renderToStaticMarkup(
      <dl>
        <FactCell icon={CpuIcon} label="Processor" value="2 vCPU" />
        <FactCell icon={PackageIcon} label="Base image" value="a/very/long/image:tag" mono />
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

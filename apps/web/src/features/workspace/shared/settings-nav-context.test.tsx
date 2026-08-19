import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SettingsNavProvider, useSettingsNav, type SettingsNav } from './settings-nav-context';

/** Reads the context and stamps its scalar fields onto data attributes so a
 *  plain `renderToStaticMarkup` string assertion can see them — mirrors the
 *  idiom in `components/ui/settings-section-header.test.tsx`. `navigate` is a
 *  function and can't round-trip through HTML, so it's checked separately by
 *  identity. */
function Probe() {
  const nav = useSettingsNav();
  return (
    <div
      data-active-tab={nav.activeTab}
      data-is-open={String(nav.isOpen)}
      data-members-tab={nav.membersTab ?? ''}
      data-llm-providers-tab={nav.llmProvidersTab ?? ''}
    />
  );
}

function baseNav(overrides: Partial<SettingsNav> = {}): SettingsNav {
  return {
    activeTab: 'secrets',
    isOpen: true,
    navigate: () => {},
    membersTab: 'people',
    llmProvidersTab: 'catalog',
    ...overrides,
  };
}

describe('useSettingsNav — outside a provider', () => {
  test('throws instead of returning a silent no-op default', () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/SettingsNavProvider/);
  });
});

describe('useSettingsNav — inside a provider', () => {
  test('passes every scalar field through unchanged', () => {
    const html = renderToStaticMarkup(
      <SettingsNavProvider value={baseNav({ activeTab: 'members', membersTab: 'invite' })}>
        <Probe />
      </SettingsNavProvider>,
    );
    expect(html).toContain('data-active-tab="members"');
    expect(html).toContain('data-is-open="true"');
    expect(html).toContain('data-members-tab="invite"');
    expect(html).toContain('data-llm-providers-tab="catalog"');
  });

  test('llmProvidersTab renders empty when the hosting panel has no equivalent (new-panel adapter)', () => {
    const html = renderToStaticMarkup(
      <SettingsNavProvider value={baseNav({ llmProvidersTab: undefined })}>
        <Probe />
      </SettingsNavProvider>,
    );
    expect(html).toContain('data-llm-providers-tab=""');
  });

  test('a nested consumer receives the exact navigate function given to the provider', () => {
    // Renders through a plain prop callback (invoked during render, but not
    // assigning an outer-scope binding) rather than mutating a variable
    // captured by closure — the latter trips `react-hooks/globals` ("Cannot
    // reassign variables declared outside of the component/hook").
    let seen: SettingsNav['navigate'] | null = null;
    const onCapture = (nav: unknown) => {
      seen = (nav as SettingsNav).navigate;
    };
    function CaptureNavigate({ report }: { report: (nav: unknown) => void }) {
      const nav = useSettingsNav();
      report(nav);
      return null;
    }
    const navigate = () => {};
    renderToStaticMarkup(
      <SettingsNavProvider value={baseNav({ navigate })}>
        <CaptureNavigate report={onCapture} />
      </SettingsNavProvider>,
    );
    expect(seen).toBe(navigate);
  });

  test('isOpen=false still resolves the hook (only closed-panel behavior is a view\'s concern, not the context\'s)', () => {
    const html = renderToStaticMarkup(
      <SettingsNavProvider value={baseNav({ isOpen: false })}>
        <Probe />
      </SettingsNavProvider>,
    );
    expect(html).toContain('data-is-open="false"');
  });
});

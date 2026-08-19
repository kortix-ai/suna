import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Page chrome for Channels — now pinned from the other side.
 *
 * This file used to assert that `ChannelsView` rendered its own
 * `CapabilityPageShell`, because Channels was a top-level Customize tab and a
 * routed page owns its chrome. It is not a tab any more: it is the Channels
 * scope of `/projects/<id>/connectors`, and the shell belongs to
 * `connectors-page.tsx` one level up. So every assertion here inverted, and
 * the defect it guards inverted with it.
 *
 * **What can go wrong now.** A `CapabilityPageShell` left in this module would
 * nest inside the page's — a second `<h1>` under the first, and a second
 * `overflow-y-auto` inside the layout's one bounded `h-svh` column, which
 * scrolls the inner box while the header stays put. The old failure (a page
 * with no shell at all, heading pressed flush against the tab bar, content
 * that cannot scroll) is now impossible for this module to cause, because it
 * no longer mounts as a page.
 *
 * The other half is the mount itself: content that renders under no scope is
 * content nothing can reach. That is asserted against `connectors-page.tsx`.
 *
 * Source-level assertions, following `secrets-view.chrome.test.ts` and
 * `schedule-view.test.tsx`: apps/web has no DOM testing library, and what is
 * pinned here is WHERE a control is mounted, not what it renders.
 */
const source = readFileSync(join(import.meta.dir, 'channels-view.tsx'), 'utf8');
const pageSource = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'capabilities', 'connectors', 'connectors-page.tsx'),
  'utf8',
);

/** Comments name the old layout on purpose; assert on code only. */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = strip(source);
const pageCode = strip(pageSource);

/**
 * `ChannelsSection` itself, without the row/table components defined under it.
 *
 * The scroll-container assertion has to read this slice rather than the whole
 * file: `EmailChannelRow`'s connect modal legitimately carries an
 * `overflow-y-auto` on its `ModalBody`, which is a modal's own scroller and
 * has nothing to do with the page's.
 */
const sectionStart = code.indexOf('export function ChannelsSection');
const sectionEnd = code.indexOf('function SlackChannelRow');
const section = code.slice(sectionStart, sectionEnd);

describe('ChannelsSection chrome', () => {
  test('the sources under test are readable and non-trivial', () => {
    expect(code.length).toBeGreaterThan(400);
    expect(pageCode.length).toBeGreaterThan(400);
  });

  test('it is a section: no shell, no heading, no second scroll container', () => {
    expect(sectionStart).toBeGreaterThan(-1);
    expect(sectionEnd).toBeGreaterThan(sectionStart);
    // The shell is the Connectors page's, and there is exactly one.
    expect(code).not.toContain('CapabilityPageShell');
    expect(section).not.toContain('overflow-y-auto');
    expect(code).not.toContain('<h1');
    // The panel-shaped chrome it shed on the way through its brief life as a
    // tab stays shed — none of these come back on the way down either.
    expect(code).not.toContain('mx-auto w-full max-w-2xl');
    expect(code).not.toContain('SettingsSectionHeader');
    expect(code).not.toContain('SettingsTabHeader');
    expect(code).not.toContain('CustomizeSectionWrapper');
  });

  /**
   * The Connectors shell is `max-w-5xl` for a 3-up card grid. This body is a
   * hero card over a row list, and at 1024px the hero's `aspect-[3/1]` cover
   * is ~341px of mostly-empty gradient. Capped, and capped LEFT — a centred
   * column under the shell's left-aligned `<h1>` reads as a misalignment.
   */
  test('the body caps its own measure, flush left', () => {
    expect(code).toContain('className="w-full max-w-3xl space-y-6"');
    expect(code).not.toContain('mx-auto w-full max-w-3xl');
  });

  test('the Connectors page mounts it under the Channels scope', () => {
    expect(pageCode).toContain("channels: 'Channels'");
    expect(pageCode).toContain("const channelsActive = scope === 'channels';");
    expect(pageCode).toContain('<ChannelsSection projectId={projectId} />');
    // Lazy, like the two other click-gated surfaces on that page: this module
    // reaches `connectors-view.tsx` through `EmailConnectForm`, and a static
    // import would put that 5,000-line graph in front of the catalogue grid
    // for every visitor who never opens this tab.
    expect(pageCode).toMatch(/const ChannelsSection = dynamic\(/);
  });

  /**
   * The heading is the page's, and it has to follow the scope. "Give agents
   * access to outside tools and data" is false over Slack/Teams/email install
   * — nothing there grants an agent access to anything, it makes the agent
   * reachable. The sentence itself is the one this pane has always carried.
   */
  test('the page heading says what a channel is for while the scope is up', () => {
    expect(pageCode).toContain('description={SCOPE_DESCRIPTION[scope]}');
    expect(pageCode).toContain("channels: 'Reach your agent from the tools your team already uses.'");
  });

  /**
   * `/projects/<id>/channels` was a real route this morning. It forwards
   * rather than 404s, and it forwards through the same helper the nav and the
   * `GRADUATED` map use, so one edit moves all of them.
   */
  test('the retired route redirects instead of disappearing', () => {
    const retired = strip(
      readFileSync(
        join(
          import.meta.dir,
          '..','..','..','..','..',
          'app','(app)','projects','[id]','(capabilities)','channels','page.tsx',
        ),
        'utf8',
      ),
    );
    expect(retired).toContain("import { redirect } from 'next/navigation'");
    expect(retired).toContain('redirect(channelsHref(id))');
    expect(retired).not.toContain('ChannelsPage');
  });
});

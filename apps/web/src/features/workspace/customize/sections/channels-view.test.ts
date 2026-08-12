import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;

/**
 * Comments stripped, so every assertion below is about CODE.
 *
 * This matters in both directions and the first version of this file got it
 * wrong in eight places. These modules carry header comments documenting what
 * the redesign removed, and documenting a removal means naming the removed
 * thing — `SectionCard`, `rounded-2xl`, `project_secrets`, `EmptyState`,
 * `type="checkbox"`. Read against raw file text, every "this is gone"
 * assertion failed on the prose explaining that it is gone. The mirror-image
 * bug is worse and silent: a "this is present" assertion satisfied by a
 * mention in a comment passes while the implementation is missing.
 *
 * The `[^:\w]` guard on line comments keeps `https://` URLs intact.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\w])\/\/.*$/gm, '$1');
}

const read = (relativePath: string) => code(readFileSync(join(dir, relativePath), 'utf8'));

const channelsSource = read('view/channels-view.tsx');
const connectorsSource = read('connectors-view.tsx');
const teamsPanelSource = read('teams-channel-panel.tsx');
const connectCardSource = read('component/slack-connect-card.tsx');
const wizardSource = read('component/slack-byo-wizard.tsx');
const coverSource = read('component/slack-connect-cover.tsx');
const blogCoverSource = read('../../../../components/blog/blog-cover.tsx');
const channelRowSource = read('component/channel-row.tsx');
const copyBlockSource = read('component/manifest-copy-block.tsx');

// These are source-text assertions, which are only worth having if they can
// actually fail. Three guards keep them honest: comments are stripped (above),
// every source string is non-empty — a renamed or moved file throws at read
// time — and each describe block pairs a "the new shape is present" assertion
// with a "the old shape is gone" one, so neither a revert nor a half-migration
// passes.
/**
 * Every module this suite reads, for the table-driven blocks below.
 *
 * These iterate with a plain `for…of` rather than `test.each`: bun's
 * `@types/bun` has no `each` on `test`, so `test.each` typechecks as
 * `TS2339 Property 'each' does not exist` plus an implicit-any per callback
 * parameter. Three files in this app already carry that error set as known
 * noise; this one does not join them.
 */
const MODULES: Array<[name: string, source: string]> = [
  ['channels-view', channelsSource],
  ['slack-connect-card', connectCardSource],
  ['slack-byo-wizard', wizardSource],
  ['slack-connect-cover', coverSource],
  ['channel-row', channelRowSource],
  ['manifest-copy-block', copyBlockSource],
  ['teams-channel-panel', teamsPanelSource],
];

describe('the sources under test are readable and non-trivial', () => {
  for (const [name, source] of MODULES) {
    test(`${name} has real content after comments are stripped`, () => {
      expect(source.length).toBeGreaterThan(400);
    });
  }
});

describe('Channels view — a disconnected Slack is a hero, not a table row', () => {
  test('the hero renders only while there is no installation', () => {
    expect(channelsSource).toMatch(/install \? null : \(\s*<SlackConnectCard/);
  });

  test('once connected, Slack becomes a peer row in the same list as Email and Teams', () => {
    // Not its own list above a "More channels" heading — the label is
    // suppressed precisely when Slack has joined the rows.
    expect(channelsSource).toContain('const showMoreLabel = !slackRow && hasRows;');
    expect(channelsSource).toMatch(/showMoreLabel \? <Label>More channels<\/Label> : null/);
    expect(channelsSource).toMatch(
      /<ul className="space-y-2">[\s\S]*?<SlackChannelRow[\s\S]*?<EmailChannelRow[\s\S]*?<TeamsChannelRow[\s\S]*?<\/ul>/,
    );
  });

  test('the four-column channel table is gone (its cells were all "Not connected" / em dash)', () => {
    expect(channelsSource).not.toContain('<TableHead>Platform</TableHead>');
    expect(channelsSource).not.toContain('<TableHead>Workspace</TableHead>');
    expect(channelsSource).not.toContain('<TableHead>Status</TableHead>');
    // The Slack row survives by name but is now an entity row, not a TableRow.
    expect(channelsSource).toMatch(
      /function SlackChannelRow[\s\S]*?return \(\s*<ChannelRow/,
    );
    expect(channelsSource).not.toMatch(/function SlackChannelRow[\s\S]{0,600}<TableCell/);
  });

  test('the bindings table survives — that one has real data to compare', () => {
    expect(channelsSource).toContain('function ChannelBindingsSection');
    expect(channelsSource).toContain('<Table>');
    expect(channelsSource).toContain('<TableHead>Channel</TableHead>');
    expect(channelsSource).toContain('<TableHead>Join policy</TableHead>');
  });

  test('the duplicate header CTA is gone — the hero owns the only "Add to Slack"', () => {
    // The section header used to render its own Add-to-Slack alongside the
    // row's Install. The wrapper is now called without an `action` prop.
    expect(channelsSource).not.toMatch(/action=\{[\s\S]*?oauthInstallUrl/);
    expect(channelsSource).not.toContain('Add to Slack');
    expect(connectCardSource).toContain('Add to Slack');
    expect((connectCardSource.match(/Add to Slack/g) ?? []).length).toBe(1);
  });

  test('dead ConnectedDetails is deleted, not left orphaned', () => {
    expect(channelsSource).not.toContain('function ConnectedDetails');
  });
});

describe('Slack connect card — the payoff renders before the commitment', () => {
  test('shows the cover art and plain-language benefits, not just a button', () => {
    expect(connectCardSource).toContain('<SlackConnectCover');
    expect(connectCardSource).toContain('SLACK_BENEFITS');
    expect(connectCardSource).toContain('Nothing for your teammates to install');
  });

  test('the cover reuses the blog BlogCover instead of hand-drawing a mock', () => {
    // ~130 lines of hand-drawn fake Slack thread became a wrapper around the
    // component the blog already renders on post cards and post pages.
    expect(coverSource).toContain("from '@/components/blog/blog-cover'");
    expect(coverSource).toContain('<BlogCover');
    expect(coverSource).toContain("name: 'Slack'");
    // No re-drawn chrome: no channel bar, no fake avatars, no mention pill.
    expect(coverSource).not.toContain('PreviewMessage');
    expect(coverSource).not.toContain('KortixLogo');
    expect(coverSource).not.toContain('HashIcon');
  });

  test('the Slack mark comes from the repo SVG, not a third-party favicon fetch', () => {
    // BRAND_ICONS had no `slack` key, so LogoChip fell through to
    // google.com/s2/favicons — a network request for a mark we already ship.
    expect(blogCoverSource).toContain("import { Slack } from '@/features/icon/icons/slack'");
    expect(blogCoverSource).toMatch(/BRAND_ICONS[\s\S]*?slack: Slack,/);
    expect(coverSource).not.toContain('favicons');
  });

  test('the cover keeps the 520 KB dark-only JPEG out of a settings panel', () => {
    expect(coverSource).not.toContain('operation_1');
    expect(coverSource).not.toContain('usecases/slack');
    expect(connectCardSource).not.toContain('usecases/slack');
  });

  test('the lockup is hidden from screen readers, since the heading already says it', () => {
    expect(coverSource).toContain('aria-hidden');
    // Labelling it would announce "Slack and Kortix" twice, next to <h3>Slack</h3>.
    expect(coverSource).not.toContain('aria-label');
  });

  test('the cover is sized for a settings panel, not the blog 16/9', () => {
    // A wide, short ratio (N/1) — the exact N is a taste call that has already
    // moved once, so pinning it would fail on a tweak rather than a regression.
    // What must hold is that the cover is explicitly sized and is NOT the
    // blog's 16/9, which at max-w-2xl (672px) would be a 378px settings hero.
    expect(coverSource).toMatch(/aspect-\[\d+\/1\]/);
    expect(coverSource).not.toContain('aspect-[16/9]');
    expect(coverSource).not.toContain('aspect-[16/10]');
  });

  test('the cover sits flush, with no tinted band fighting its own gradient', () => {
    expect(connectCardSource).not.toContain('bg-muted/30 border-b p-4');
    const wrapper = connectCardSource.match(/<div className="([^"]*)">\s*<SlackConnectCover/)?.[1];
    // Read the wrapper's classes rather than pin its whole string: the cover is
    // `scale-120`, so the wrapper's `overflow-hidden` is load-bearing — without
    // it the upscaled band spills over the copy beneath. What must not appear
    // is a fill or an inset, either of which puts a second surface between the
    // panel and the cover's own gradient.
    const classes = wrapper?.split(/\s+/).filter(Boolean) ?? [];
    expect(classes).toContain('border-b');
    expect(classes.filter((name) => name.startsWith('bg-'))).toEqual([]);
    expect(classes.filter((name) => /^-?p[xytblrse]?-/.test(name))).toEqual([]);
  });

  test('a self-hosted install with no managed app is a path, not an EmptyState', () => {
    expect(channelsSource).not.toContain('EmptyState');
    expect(connectCardSource).toContain('Set up Slack');
    expect(connectCardSource).toContain('<SlackByoWizard');
  });

  test('read-only members get an explanation instead of a dead button', () => {
    expect(connectCardSource).toContain('Ask a workspace admin to connect Slack');
  });
});

describe('Bring your own Slack — a guided wizard, not a JSON dump', () => {
  test('three steps driven by the shared Stepper, inside a Modal', () => {
    expect(wizardSource).toContain("from '@/components/ui/stepper'");
    expect(wizardSource).toContain('<Stepper');
    expect(wizardSource).toContain('ModalContent');
    expect(wizardSource).toMatch(/const STEPS = \[[\s\S]*?step: 3/);
  });

  test('the prose step counter is gone', () => {
    expect(wizardSource).not.toContain('Step 1 of 2');
    expect(wizardSource).not.toContain('Step 2 of 2');
    expect(channelsSource).not.toContain('SLACK_MANIFEST_STEPS');
    expect(channelsSource).not.toContain('function BringYourOwnPanel');
  });

  test('the manifest is one bounded, copyable block — not a button plus a disclosure', () => {
    // One control for one object, and the filename is the framing: a file you
    // copy and paste, not JSON you are expected to read.
    expect(wizardSource).toContain('<ManifestCopyBlock');
    expect(wizardSource).toContain('filename="slack-app-manifest.json"');
    // The disclosure that used to hide the JSON, and the second <pre>, are gone.
    expect(wizardSource).not.toContain('Show what&apos;s in the setup file');
    expect(wizardSource).not.toContain('<Disclosure');
    expect(wizardSource).not.toContain('<pre');
  });

  test('the block shows the real file, bounded and scrollable, on bg-secondary', () => {
    expect(copyBlockSource).toContain('bg-secondary');
    expect(copyBlockSource).toContain('rounded-md');
    // Bounded AND scrollable is the contract; the exact cap is a taste call
    // that may move, so pinning the pixel value would only break on a tweak.
    expect(copyBlockSource).toMatch(/max-h-\d+ overflow-auto/);
    expect(copyBlockSource).toContain('{text}');
    // A fade signals there is more below, and must never eat a scroll gesture.
    expect(copyBlockSource).toMatch(/from-secondary[\s\S]{0,80}pointer-events-none/);
  });

  test('the copy control lives in a header row, so it occludes no code', () => {
    // Index ordering, not a length-bounded regex: the earlier version budgeted
    // characters between the two anchors and so broke on any edit in between,
    // which made it fail for reasons that had nothing to do with layout.
    const header = copyBlockSource.indexOf('flex items-center justify-between');
    const filename = copyBlockSource.indexOf('{filename}');
    const copy = copyBlockSource.indexOf('<CopyButton');
    const body = copyBlockSource.indexOf('<pre');
    expect(header).toBeGreaterThan(-1);
    // Both controls sit in the header, above the code — never over it.
    expect(filename).toBeGreaterThan(header);
    expect(copy).toBeGreaterThan(header);
    expect(body).toBeGreaterThan(copy);
    // Not CopyOverlay, and not an overlay pinned on top of the first line.
    expect(copyBlockSource).not.toContain('CopyOverlay');
    expect(copyBlockSource).not.toMatch(/absolute[^"]*top-[0-9][^"]*left/);
  });

  test('the block composes the shipped code primitives instead of hand-rolling them', () => {
    // The barrel's own rule: own frame -> HighlightedCode. This frame is bespoke
    // (copy top-left, ~3-line cap, bg-secondary), the body and control are not.
    expect(copyBlockSource).toContain("from '@/components/markdown/code'");
    expect(copyBlockSource).toContain('<HighlightedCode');
    expect(copyBlockSource).toContain("from '@/components/markdown/copy-button'");
    expect(copyBlockSource).toContain('<CopyButton');
  });

  test('the manifest is syntax-highlighted, not a bare pre of raw text', () => {
    // json is in Shiki's PRELOAD_LANGS, so highlightSync resolves on first paint.
    expect(copyBlockSource).toContain("language = 'json'");
    expect(copyBlockSource).toMatch(/<HighlightedCode code=\{text\} language=\{language\}/);
    // The old hand-rolled body interpolated the text straight into the <pre>.
    expect(copyBlockSource).not.toMatch(/<pre[^>]*>\s*\{text\}/);
  });

  test('it carries the Shiki resets a bare pre would be missing', () => {
    expect(copyBlockSource).toContain('[&_code]:bg-transparent');
    expect(copyBlockSource).toContain('[&_.shiki]:!bg-transparent');
  });

  test('there is exactly one copy implementation — no second AnimatePresence swap here', () => {
    expect(copyBlockSource).not.toContain('AnimatePresence');
    expect(copyBlockSource).not.toContain('navigator.clipboard');
    expect(copyBlockSource).not.toContain("filter: 'blur(4px)'");
  });

  test('the artefact is named by the filename, and no dead label prop survives', () => {
    // The filename identifies the file; CopyButton carries its own aria-label.
    expect(copyBlockSource).toContain('{filename}');
    // A `Hint` cannot wrap CopyButton (asChild clones a component that neither
    // forwards a ref nor spreads props), so no tooltip is claimed here...
    expect(copyBlockSource).not.toContain('<Hint');
    // ...and the `label` prop it used to feed is gone rather than left dangling
    // for callers to pass into nothing.
    expect(copyBlockSource).not.toMatch(/^\s*label\?: string;/m);
    expect(teamsPanelSource).not.toContain('label="Copy manifest"');
  });

  test('loading and error states render inside the block, not as sibling banners', () => {
    expect(copyBlockSource).toContain('<Skeleton');
    expect(copyBlockSource).toMatch(/error \?/);
    expect(wizardSource).not.toContain('Could not load the setup file');
  });

  test('credential help names the Slack screen, and internal table names are gone', () => {
    expect(wizardSource).toContain('OAuth &amp; Permissions');
    expect(wizardSource).toContain('Basic Information');
    expect(wizardSource).not.toContain('project_secrets');
    expect(channelsSource).not.toContain('project_secrets');
  });

  test('still writes through the shared connect mutation — no ad-hoc fetch', () => {
    expect(wizardSource).toContain('useConnectSlack');
    expect(wizardSource).toContain('useSlackManifest');
    expect(wizardSource).toContain('bot_token');
    expect(wizardSource).toContain('signing_secret');
    expect(wizardSource).not.toContain('fetch(');
  });

  test('the house icon-swap values live in the shared CopyButton, once', () => {
    const copyButton = read('../../../../components/markdown/copy-button.tsx');
    expect(copyButton).toContain("filter: 'blur(4px)'");
    expect(copyButton).toContain('scale: 0.25');
    expect(copyButton).toContain('bounce: 0');
    expect(copyButton).toContain('initial={false}');
    // Teams' old local button hard-swapped the glyphs; nothing does now.
    expect(teamsPanelSource).not.toMatch(/\{copied \? <Check/);
    expect(teamsPanelSource).not.toContain('navigator.clipboard');
  });
});

describe('Channels view — Email and Teams are entity rows', () => {
  test('both render through the shared ChannelRow', () => {
    expect(channelsSource).toContain(
      "from '@/features/workspace/customize/sections/component/channel-row'",
    );
    expect(channelsSource).toContain('function EmailChannelRow');
    expect(channelsSource).toContain('function TeamsChannelRow');
    expect(channelsSource).toMatch(/<EmailChannelRow[\s\S]*<TeamsChannelRow/);
    expect(channelsSource).toContain('<MicrosoftTeams');
  });

  test('a disconnected row says what the channel does instead of an em dash', () => {
    expect(channelRowSource).toContain('pitch');
    expect(channelsSource).toContain('Give your agent an inbox it can read and reply from.');
    expect(channelsSource).toContain('Mention your agent in a Teams channel or chat.');
  });

  test('disconnect keeps its two-step inline confirmation', () => {
    expect(channelRowSource).toContain('function ChannelDisconnectButton');
    expect(channelRowSource).toContain('setConfirming(true)');
    expect(channelRowSource).toContain('variant="destructive"');
    expect(channelsSource).toContain('<ChannelDisconnectButton');
    expect((channelsSource.match(/<ChannelDisconnectButton/g) ?? []).length).toBe(3);
  });

  test('reuses the connector connect form inside a modal instead of redirecting', () => {
    expect(channelsSource).toContain('EmailConnectForm');
    expect(channelsSource).toContain(
      "from '@/features/workspace/customize/sections/connectors-view'",
    );
    expect(connectorsSource).toContain('export function EmailConnectForm');
  });

  test('reuses the shared installation hooks as the single source of truth', () => {
    expect(channelsSource).toContain('useDisconnectSlack');
    expect(channelsSource).toContain('useDisconnectEmail');
    expect(channelsSource).toContain("from '@/hooks/channels/use-teams-installations'");
    expect(channelsSource).toContain('useTeamsInstall');
    expect(channelsSource).toContain('useTeamsMode');
    expect(channelsSource).toContain('useDisconnectTeams');
    expect(channelsSource).toContain('orgConsentUrl');
    expect(channelsSource).toContain('deepLinkUrl');
    expect(channelsSource).toContain('Add to Teams');
  });

  test('keeps Email and Teams behind their per-project flags', () => {
    expect(channelsSource).toContain("useFeatureFlag(projectId, 'agentmail_email')");
    expect(channelsSource).toContain("EMAIL_CONNECTOR_SLUG = 'kortix_email'");
    expect(channelsSource).toContain("const teamsFlag = useFeatureFlag(projectId, 'teams');");
    expect(channelsSource).toContain('const teamsChannelEnabled = teamsFlag.enabled;');
    expect(channelsSource).toMatch(/emailChannelEnabled \? \(\s*<EmailChannelRow/);
    expect(channelsSource).toMatch(/teamsChannelEnabled \? \(\s*<TeamsChannelRow/);
    expect(channelsSource).toMatch(/teamsChannelEnabled \? <TeamsChannelPanel/);
    // The old summary-query read (one hop shallower than every sibling) stays gone.
    expect(channelsSource).not.toContain('?.experimental?.');
    expect(channelsSource).not.toContain('if (mode && !mode.enabled) return null;');
  });

  test('long workspace / tenant / address values still truncate', () => {
    expect(channelRowSource).toMatch(/max-w-\[240px\] truncate/);
  });
});

describe('Channels view — per-channel binding management (spec §2.5)', () => {
  test('the bindings table renders only once Slack is connected', () => {
    // The gate moved into SlackFollowUp, which is itself behind `install` —
    // it did not disappear.
    expect(channelsSource).toMatch(/install \? <SlackFollowUp/);
    expect(channelsSource).toMatch(/function SlackFollowUp[\s\S]*?<ChannelBindingsSection/);
  });

  test('reads/writes bindings through the shared hook (no ad-hoc fetches)', () => {
    expect(channelsSource).toContain("from '@/hooks/channels/use-channel-bindings'");
    expect(channelsSource).toContain('useChannelBindings');
    expect(channelsSource).toContain('useUpdateChannelBinding');
  });

  test('the post-connect nudge retires once a channel is actually bound', () => {
    expect(channelsSource).toContain('bindings.length === 0');
    expect(channelsSource).toContain('One more step, in Slack');
  });

  test('agent picker reuses the shared AgentSelector, offering a project-default entry', () => {
    expect(channelsSource).toContain("from '@/features/session/session-chat-input'");
    expect(channelsSource).toContain('<AgentSelector');
    expect(channelsSource).toContain('useVisibleAgents');
    expect(channelsSource).toContain('Project default');
  });

  test('model override reuses the shared ModelSelector and labels the unset state', () => {
    expect(channelsSource).toContain("from '@/features/session/model-selector'");
    expect(channelsSource).toContain('<ModelSelector');
    expect(channelsSource).toContain('unsetLabel="Project default"');
  });

  test('join-policy picker covers all three conversation policies', () => {
    expect(channelsSource).toContain("value: 'project_open'");
    expect(channelsSource).toContain("value: 'owner_only'");
    expect(channelsSource).toContain("value: 'owner_approval'");
  });

  test('read-only members see static values instead of editable controls', () => {
    expect(channelsSource).toContain('canManage');
    expect(channelsSource).toContain('disabled={!canManage');
  });
});

describe('Channels view — no banned primitives in the rebuilt surface', () => {
  for (const [name, source] of MODULES) {
    test(`${name} uses no SectionCard, List, or Dialog`, () => {
      expect(source).not.toContain('SectionCard');
      expect(source).not.toContain("from '@/components/ui/list'");
      expect(source).not.toContain('DialogContent');
    });

    test(`${name} uses Loading for spinners, never an animate-spin icon`, () => {
      expect(source).not.toContain('animate-spin');
      expect(source).not.toContain('CircleNotch');
      expect(source).not.toContain('SpinnerIcon');
    });

    test(`${name} keeps app containers at rounded-md or tighter`, () => {
      expect(source).not.toContain('rounded-xl');
      expect(source).not.toContain('rounded-2xl');
    });

    test(`${name} colours with kortix-* tokens, never the raw Tailwind palette`, () => {
      expect(source).not.toMatch(
        /\b(?:bg|text|border)-(?:red|blue|green|emerald|amber|slate|zinc|teal|orange|yellow)-\d{2,3}\b/,
      );
    });
  }
});

describe('Teams panel — chrome aligned with the rebuilt Slack surface', () => {
  test('is the bring-your-own-bot card, built on the shared Disclosure', () => {
    expect(teamsPanelSource).toContain('Use your own Microsoft Teams app');
    expect(teamsPanelSource).toContain("from '@/components/ui/disclosure'");
    expect(teamsPanelSource).toContain('<DisclosureTrigger');
    expect(teamsPanelSource).not.toContain('ConnectedPanel');
    expect(teamsPanelSource).not.toContain('DisconnectedPanel');
  });

  test('errors go through InfoBanner rather than a hand-rolled tinted paragraph', () => {
    expect(teamsPanelSource).toContain('tone="destructive"');
    expect(teamsPanelSource).not.toContain('bg-destructive/5');
  });

  test('the managed/BYO toggle is a Switch, not a raw checkbox', () => {
    expect(teamsPanelSource).not.toContain('type="checkbox"');
    expect(teamsPanelSource).toContain('<Switch');
  });

  test('shares one manifest-copy implementation with the Slack wizard', () => {
    expect(teamsPanelSource).toContain('<ManifestCopyBlock');
    expect(wizardSource).toContain('<ManifestCopyBlock');
    expect(teamsPanelSource).toContain('filename="teams-app-manifest.json"');
  });

  test('the block absorbed the uppercase caption and the separate manifest <pre>', () => {
    expect(teamsPanelSource).not.toContain('App manifest');
    expect(teamsPanelSource).not.toContain('<pre');
    expect(teamsPanelSource).not.toContain('max-h-64');
  });
});

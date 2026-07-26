import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { EndCard, ProductShot, ProgressShot, PromptShot, StatementCard, TitleCard } from './scenes';
import { FONT_CSS, color } from './theme';

/**
 * "Kortix Sizzle" — the hero film.
 *
 * Beat structure is lifted from the ChatGPT Work launch film: title card →
 * typographic statement → product beat → prompt close-up → statement → product
 * → payoff → end card. Every product beat is a real screenshot of the running
 * app, so the film can't drift from what Kortix actually looks like.
 *
 * Timings are in frames at 30fps. Total: 1290 frames = 43s.
 */

type Beat = { from: number; duration: number; el: React.ReactNode };

const BEATS: Beat[] = [
  { from: 0, duration: 110, el: <TitleCard text="Introducing Kortix" subtitle="The AI command center for your company" /> },
  { from: 110, duration: 90, el: <StatementCard text="Your company already has the work." /> },
  { from: 200, duration: 130, el: <PromptShot prompt="Reconcile last week's Stripe payouts against the ledger and flag what disagrees." /> },
  { from: 330, duration: 120, el: <ProgressShot steps={['Boot sandbox', 'Pull Stripe payouts', 'Read the ledger', 'Reconcile and flag', 'Open change request']} /> },
  { from: 450, duration: 90, el: <StatementCard text="Every task runs on its own machine." /> },
  { from: 540, duration: 130, el: <ProductShot shot="01-command-center.png" caption="One command center for every project" /> },
  { from: 670, duration: 90, el: <StatementCard text="Connect the tools you already pay for." /> },
  { from: 760, duration: 130, el: <ProductShot shot="04-connectors.png" caption="3,000+ apps, plus MCP and OpenAPI" align="left" /> },
  { from: 890, duration: 90, el: <StatementCard text="Teach it how your company works." /> },
  { from: 980, duration: 120, el: <ProductShot shot="03-skills.png" caption="Skills ride into every session" /> },
  { from: 1100, duration: 90, el: <StatementCard text="And it's a repo you own." /> },
  { from: 1190, duration: 100, el: <EndCard line="Kortix" cta="Open source · kortix.com" /> },
];

export const TOTAL_FRAMES = 1290;

export const Sizzle: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: color.paper }}>
    {/* biome-ignore lint/security/noDangerouslySetInnerHtml: local @font-face for the brand faces */}
    <style dangerouslySetInnerHTML={{ __html: FONT_CSS }} />
    {BEATS.map((beat) => (
      <Sequence key={beat.from} from={beat.from} durationInFrames={beat.duration}>
        {beat.el}
      </Sequence>
    ))}
  </AbsoluteFill>
);

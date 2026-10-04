import { Shot, type Cue, type FilmDef } from '../../engine/film';
import { bars, beats } from '../../engine/time';
import { ColdOpen, Reveal } from './act-1';
import { ChangeRequest, Repo, Session, Workforce } from './act-2';
import { Connectors, EndCard, OpenSource, Surfaces, Triggers } from './act-3';

/**
 * The launch film. 32 bars at 120 BPM = 64 s. The storyboard, the motion
 * rules and the claim sources: `.agents/skills/kortix-presentation/references/films.md`.
 * Each row is [start bar, length in bars]; cuts land on bar lines.
 */
const B = {
  cold: [0, 3],
  reveal: [3, 2],
  repo: [5, 3],
  session: [8, 3],
  workforce: [11, 3],
  cr: [14, 3],
  connectors: [17, 3],
  surfaces: [20, 3],
  triggers: [23, 2],
  open: [25, 4],
  end: [29, 3],
} as const;

const at = (k: keyof typeof B) => bars(B[k][0]);
const len = (k: keyof typeof B) => bars(B[k][1]);

function LaunchFilm() {
  return (
    <>
      <Shot from={at('cold')} dur={len('cold')} enter="cut" exit="settle"><ColdOpen /></Shot>
      <Shot from={at('reveal')} dur={len('reveal')} enter="settle"><Reveal /></Shot>
      <Shot from={at('repo')} dur={len('repo')}><Repo /></Shot>
      <Shot from={at('session')} dur={len('session')}><Session /></Shot>
      <Shot from={at('workforce')} dur={len('workforce')}><Workforce /></Shot>
      <Shot from={at('cr')} dur={len('cr')}><ChangeRequest /></Shot>
      <Shot from={at('connectors')} dur={len('connectors')}><Connectors /></Shot>
      <Shot from={at('surfaces')} dur={len('surfaces')}><Surfaces /></Shot>
      <Shot from={at('triggers')} dur={len('triggers')}><Triggers /></Shot>
      <Shot from={at('open')} dur={len('open')} exit="settle"><OpenSource /></Shot>
      <Shot from={at('end')} dur={len('end')} enter="settle" exit="cut"><EndCard /></Shot>
    </>
  );
}

/** Frame-exact sound. Effect names are files in `scripts/film/sfx/`. */
const cues: Cue[] = [
  // cold open: one soft tick per line
  { frame: 10, sfx: 'tick', gain: 0.5 },
  { frame: 118, sfx: 'tick', gain: 0.5 },
  { frame: 232, sfx: 'tick', gain: 0.6 },
  { frame: 262, sfx: 'tick', gain: 0.6 },
  // the reveal lands on bar 3
  { frame: at('reveal'), sfx: 'impact', gain: 1 },
  // a whoosh on every push cut
  ...(['repo', 'session', 'workforce', 'cr', 'connectors', 'surfaces', 'triggers', 'open'] as const).map(
    (k) => ({ frame: at(k) - 10, sfx: 'whoosh', gain: 0.45 }),
  ),
  // the session: typing, send, one tick per resolved step
  { frame: at('session') + 22, sfx: 'typing', gain: 0.35 },
  { frame: at('session') + 86, sfx: 'click', gain: 0.7 },
  ...[140, 170, 200, 230].map((f) => ({ frame: at('session') + f, sfx: 'tick', gain: 0.45 })),
  // the approval and the merge — the payoff
  { frame: at('cr') + 222, sfx: 'click', gain: 0.9 },
  { frame: at('cr') + 230, sfx: 'chime', gain: 0.8 },
  // surfaces switch on the bar
  { frame: at('surfaces') + beats(4), sfx: 'tick', gain: 0.5 },
  { frame: at('surfaces') + beats(8), sfx: 'tick', gain: 0.5 },
  // terminal
  { frame: at('open') + 30, sfx: 'typing', gain: 0.3 },
  { frame: at('open') + 104, sfx: 'typing', gain: 0.3 },
  { frame: at('open') + 184, sfx: 'chime', gain: 0.45 },
  // end card
  { frame: at('end'), sfx: 'impact', gain: 0.7 },
];

export const launchFilm: FilmDef = {
  slug: 'launch',
  title: 'Kortix — launch film',
  description:
    'Kortix, the open-source AI Management System, in 64 seconds: one repo, a computer per session, change requests you approve.',
  frames: bars(32),
  Film: LaunchFilm,
  cues,
  score: {
    bars: 32,
    sections: [[0, 'intro'], [3, 'reveal'], [5, 'groove'], [25, 'break'], [27, 'lift'], [29, 'end']],
    cycle_from: 4,
    risers: [[3, 3], [27, 2], [29, 1.5]],
    impacts: [[3, 0.9], [29, 0.7]],
  },
  audio: '/film/launch.m4a',
  chapters: [
    { frame: at('cold'), label: 'A toy or a cage' },
    { frame: at('reveal'), label: 'Kortix' },
    { frame: at('repo'), label: 'A git repository' },
    { frame: at('session'), label: 'Its own computer' },
    { frame: at('workforce'), label: 'Thousands of sessions' },
    { frame: at('cr'), label: 'Change requests' },
    { frame: at('connectors'), label: 'Any app, any model' },
    { frame: at('surfaces'), label: 'Web, Slack, CLI' },
    { frame: at('triggers'), label: 'It improves itself' },
    { frame: at('open'), label: 'Open source' },
  ],
};

/**
 * The project home's greeting, rotated (Marko, 2026-09-02: "rotate the
 * messages so there are variants").
 *
 * Every variant is one sentence with the PROJECT name in the middle —
 * `before` <name> `after` — so the name stays the sentence's only highlighted
 * word and the confetti button stays where it is. The name is a project
 * ("Agent Centric Demo", "Website relaunch"), not a person or an agent, so
 * every line has to read with a project in that slot: you give a project
 * work, move it forward, ask what it needs — you do not ask it to take
 * something off your plate. An `after` that is only punctuation ("?") closes
 * the sentence straight after the name; `spaceBefore` says so.
 *
 * Rotation is a counter in localStorage, not a random pick: the next visit
 * gets the next line, so a person sees every variant before any repeats and
 * two tabs opened in a row do not show the same one. The counter is read in
 * a layout effect — before paint — so the server-rendered line (variant 0)
 * is never seen flipping.
 */
export interface HomeGreeting {
  before: string;
  after: string;
}

export const HOME_GREETINGS: readonly HomeGreeting[] = [
  { before: 'Give', after: 'something real to work on.' },
  { before: "What's next for", after: '?' },
  { before: 'Move', after: 'forward.' },
  { before: 'What does', after: 'need done?' },
  { before: 'Where does', after: 'go next?' },
  { before: 'Pick up where', after: 'left off.' },
];

/** Whether a space separates the name from `after` — none before bare
 *  punctuation, so "What's next for Website?" does not print "Website ?". */
export function spaceBefore(after: string): boolean {
  return !/^[?.!,]/.test(after);
}

export const HOME_GREETING_STORAGE_KEY = 'kortix:home-greeting';

/**
 * Which variant this visit shows, from the stored visit count. A missing or
 * garbage value counts as the first visit. Pure, so the rotation is testable
 * without a window.
 */
export function greetingIndexFor(stored: string | null, count: number = HOME_GREETINGS.length): number {
  if (count <= 0) return 0;
  const n = Number.parseInt(stored ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n % count;
}

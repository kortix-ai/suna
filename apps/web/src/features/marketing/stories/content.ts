/**
 * Customer stories — shared by `/customers`, `/services` and the home page.
 *
 * Plain English, no i18n keys yet: the copy is a draft for founder review.
 *
 * ── ACCURACY GATE ────────────────────────────────────────────────────────
 *  1. Never a customer's name, a person's name, a logo or a metric. Each story
 *     names the class of company (claims.md, "Never name a customer"). The
 *     blocked-terms guard (`scripts/check-blocked-terms.sh`) refuses a commit
 *     that names one.
 *  2. No numbers that read as results ("3x faster", "saved 40 hours"): none is
 *     measured for public use. A story says what runs, not what it earned.
 *  3. "Kortix" stories describe our own company and may be specific.
 *  4. A story describes work the deployment does today, in the present tense.
 */

export type StoryStep = { readonly id: string; readonly label: string };

export type Story = {
  readonly id: string;
  /** Industry · class of company. Never a name. */
  readonly who: string;
  readonly title: string;
  readonly body: string;
  /** The workflow, left to right: what starts it, what the agents do, what comes out. */
  readonly flow: readonly StoryStep[];
  /** Who still decides. Every story keeps a person in it. */
  readonly people: string;
};

export const stories = {
  eyebrow: 'Customer stories',
  title: 'Companies already running on agents.',
  sub: 'Each one started with one workflow. None of them is a chat window.',
  cta: 'All customer stories',
  items: [
    {
      id: 'credit-fund',
      who: 'Finance · A credit fund',
      title: 'Every new bond issue, analysed before the desk opens.',
      body: 'When a new issue is announced, a trigger starts the same multi-step analysis every time: read the offering documents, run the models, check the result against the fund’s strategy with deterministic checks. The desk opens a buy or no-buy case in a dashboard the whole team shares.',
      flow: [
        { id: 'trigger', label: 'New issue announced' },
        { id: 'read', label: 'Read the documents' },
        { id: 'model', label: 'Run the models' },
        { id: 'check', label: 'Check the strategy' },
        { id: 'out', label: 'Buy or no-buy case' },
      ],
      people: 'The trader decides.',
    },
    {
      id: 'infrastructure',
      who: 'Infrastructure · A fiber contractor',
      title: 'From the map to the permit to the offer.',
      body: 'Agents route new fiber around what is in the way, draft the permit report the authorities ask for, and turn the plan into the customer offer. Field teams add photos and inspection points through an internal App, and the agents read what they add.',
      flow: [
        { id: 'route', label: 'Route on the map' },
        { id: 'permit', label: 'Draft the permit report' },
        { id: 'offer', label: 'Build the offer' },
        { id: 'field', label: 'Field photos in an App' },
      ],
      people: 'Engineers approve every route.',
    },
    {
      id: 'homebuilder',
      who: 'Construction · A homebuilder',
      title: 'Lots, renders and a letter in the mailbox.',
      body: 'Agents find buildable lots in public geodata, render a house that fits each one, and send the owner the render by physical mail.',
      flow: [
        { id: 'lots', label: 'Find the lots' },
        { id: 'render', label: 'Render a house' },
        { id: 'mail', label: 'Mail the owner' },
      ],
      people: 'The sales team follows up.',
    },
    {
      id: 'kortix-sales',
      who: 'Software · Kortix, our own company',
      title: 'Every signup researched and answered.',
      body: 'Each new signup starts a session. The agent researches the company, scores the fit, keeps the CRM current and writes the follow-up.',
      flow: [
        { id: 'signup', label: 'New signup' },
        { id: 'research', label: 'Research the company' },
        { id: 'crm', label: 'Update the CRM' },
        { id: 'draft', label: 'Draft the follow-up' },
      ],
      people: 'A person decides what it may send.',
    },
    {
      id: 'kortix-engineering',
      who: 'Software · Kortix, our own company',
      title: 'Agents that ship our product.',
      body: 'Bug reports from Slack become tracked issues. Agents reproduce them, write the fix and open the pull request on their own branch. A reviewer agent checks the work, and an engineer merges it.',
      flow: [
        { id: 'report', label: 'Report in Slack' },
        { id: 'repro', label: 'Reproduce' },
        { id: 'fix', label: 'Fix on a branch' },
        { id: 'pr', label: 'Pull request' },
      ],
      people: 'An engineer merges.',
    },
    {
      id: 'kortix-studio',
      who: 'Media · Kortix, our own studio',
      title: 'One prompt, one finished music video.',
      body: 'A director agent writes the lyrics, scores the song, animates the scenes and cuts the video, handing parts to sub-agents along the way. It runs for hours without anyone watching.',
      flow: [
        { id: 'prompt', label: 'One prompt' },
        { id: 'lyrics', label: 'Lyrics and song' },
        { id: 'scenes', label: 'Scenes' },
        { id: 'cut', label: 'Finished video' },
      ],
      people: 'We pick what gets published.',
    },
  ] satisfies readonly Story[],
} as const;

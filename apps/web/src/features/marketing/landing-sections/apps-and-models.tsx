import { FeatureSplit } from '@/features/marketing/kit/feature-split';

// Two home sections in the same frame as the pillars. Facts: the Guide's Apps
// and Models sections (content/docs/index.mdx) and claims.md rows Price and
// Managed models. Managed models: open-weight (DeepSeek, GLM), zero data
// retention; never "SOTA", never where inference runs, and no cost ratio until
// one is measured.

const APPS = {
  title: 'Need an internal app?',
  titleMuted: 'Ask an agent for it.',
  body: [
    'Agents turn a request into **live software**: a dashboard, a tracker, an approval form or a small tool, wired to your data and your connected apps.',
    'Every App runs on Kortix at **a stable URL**, with your team signed in before it opens, and releases you can roll back.',
  ],
  cells: [
    { k: 'Dashboards', v: 'On live company data, updated by agents.' },
    { k: 'Trackers and forms', v: 'Approval flows, intake forms, internal tools.' },
    { k: 'Backends', v: 'Data, functions and realtime, for your own apps.' },
    { k: 'Shared safely', v: 'Kortix sign-in and an access policy per App.' },
  ],
};

const MODELS = {
  title: 'Every model, one bill.',
  titleMuted: 'Pay for the work, not per seat.',
  body: [
    '**Bring your own models**: Claude, GPT, Gemini or any provider with your own keys, or the ChatGPT plan you already pay for.',
    'Or run **open-weight models managed by Kortix**, DeepSeek and GLM, served with **zero data retention**, for the everyday work that does not need a frontier model.',
  ],
  cells: [
    { k: 'Any model', v: 'Pick per agent or per session. Switch when a better one ships.' },
    { k: 'Zero data retention', v: 'Managed models run only where nothing is kept.' },
    { k: 'No seats', v: 'Members are unlimited and free. One credit pool.' },
    { k: 'Budgets', v: 'Cap spend per project or per member, warn or block.' },
  ],
};

// Sample data only: Northwind is the sample company, owners are numbers. One
// row carries the kortix-orange "needs attention" mark (color.md status table).
const PROPOSALS = [
  { name: 'Acme renewal', owner: 'Owner 1', stage: 'Signed', attention: false },
  { name: 'Globex expansion', owner: 'Owner 2', stage: 'Waiting on legal', attention: true },
  { name: 'Initech pilot', owner: 'Owner 3', stage: 'Draft', attention: false },
  { name: 'Umbrella onboarding', owner: 'Owner 1', stage: 'Sent', attention: false },
];

/** A small internal App as an agent ships it: its URL, then a live table. */
function AppMock() {
  return (
    <div className="bg-muted/40 flex h-full items-center p-6 lg:p-11">
      <div className="bg-background w-full overflow-hidden rounded-lg border shadow-sm">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <span className="bg-muted size-2 rounded-full" />
          <span className="bg-muted size-2 rounded-full" />
          <span className="bg-muted size-2 rounded-full" />
          <span className="text-muted-foreground ml-2 truncate font-mono text-xs">proposals.northwind.app</span>
        </div>
        <div className="flex items-baseline justify-between px-4 pt-4">
          <p className="text-foreground text-sm font-medium">Open proposals</p>
          <p className="text-muted-foreground text-xs">Updated by an agent</p>
        </div>
        <ul className="mt-3 divide-y border-t">
          {PROPOSALS.map((row) => (
            <li key={row.name} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 text-sm sm:grid-cols-[1fr_5rem_9rem]">
              <span className="text-foreground truncate">{row.name}</span>
              <span className="text-muted-foreground hidden text-xs sm:block">{row.owner}</span>
              <span className="text-muted-foreground flex items-center gap-2 text-xs">
                {row.attention ? <span className="bg-kortix-orange size-1.5 rounded-full" aria-label="Needs attention" /> : null}
                {row.stage}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// Model families only, never versions (claims.md, Models row).
const MODEL_ROWS = [
  { name: 'Claude', source: 'Your key' },
  { name: 'GPT', source: 'Your ChatGPT plan' },
  { name: 'Gemini', source: 'Your key' },
  { name: 'DeepSeek', source: 'Managed, zero data retention', selected: true },
  { name: 'GLM', source: 'Managed, zero data retention' },
];

/** The model picker of one agent: every source in one list, one selected. */
function ModelPickerMock() {
  return (
    <div className="bg-muted/40 flex h-full items-center p-6 lg:p-11">
      <div className="bg-background w-full overflow-hidden rounded-lg border shadow-sm">
        <div className="flex items-baseline justify-between border-b px-4 py-3">
          <p className="text-foreground text-sm font-medium">Model</p>
          <p className="text-muted-foreground text-xs">Agent: Finance</p>
        </div>
        <ul className="p-1.5">
          {MODEL_ROWS.map((row) => (
            <li
              key={row.name}
              className={`flex items-center justify-between gap-3 rounded-md px-3 py-2.5 text-sm ${row.selected ? 'bg-muted' : ''}`}
            >
              <span className="text-foreground">{row.name}</span>
              <span className="text-muted-foreground truncate text-xs">{row.source}</span>
            </li>
          ))}
        </ul>
        <div className="text-muted-foreground flex items-center justify-between border-t px-4 py-3 text-xs">
          <span>Budget this month</span>
          <span className="text-foreground tabular-nums">62% used</span>
        </div>
      </div>
    </div>
  );
}

export function AppsBand() {
  return <FeatureSplit id="apps" {...APPS} layout="split" visual={<AppMock />} />;
}

export function ModelsBand() {
  return <FeatureSplit id="models" {...MODELS} layout="split" visual={<ModelPickerMock />} />;
}

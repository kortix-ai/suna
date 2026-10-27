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

export function AppsBand() {
  return <FeatureSplit id="apps" {...APPS} cols="lg:grid-cols-4" />;
}

export function ModelsBand() {
  return <FeatureSplit id="models" {...MODELS} cols="lg:grid-cols-4" />;
}

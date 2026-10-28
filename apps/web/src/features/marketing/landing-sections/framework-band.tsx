import { FeatureSplit } from '@/features/marketing/kit/feature-split';
import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import Link from 'next/link';

// Facts: framework/content.ts (accuracy gate) and /framework. Naming pi here
// is decision D24: the framework surfaces may name the harness.
const FRAMEWORK = {
  title: 'A workspace for your team.',
  titleMuted: 'A framework underneath.',
  body: [
    'People work in the Kortix workspace. Underneath, Kortix is a **backend framework for agents**: a project is a git repository, and **kortix.yaml** declares its agents, skills, tools and triggers.',
    'Every session runs the **open-source pi coding agent** on its own computer. Triggers run agent loops **24/7**. **@kortix/sdk** and **@kortix/ui** let you build your own experience on the same backend.',
  ],
  cells: [
    { k: 'kortix.yaml', v: 'Agents, access, tools and triggers in one versioned file.' },
    { k: 'pi coding agent', v: 'The open-source agent every session runs, on its own computer.' },
    { k: '@kortix/sdk', v: 'One typed client for projects, sessions and live events.' },
    { k: '@kortix/ui', v: 'The React components the Kortix workspace is built from.' },
  ],
};

export function FrameworkBand() {
  return (
    <FeatureSplit
      id="framework"
      {...FRAMEWORK}
      cols="lg:grid-cols-4"
      after={
        <div className="mt-8 px-8 lg:px-28">
          <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
            <Link href="/framework">See the architecture</Link>
          </MarketingButton>
        </div>
      }
    />
  );
}

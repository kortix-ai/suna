'use client';

import { MarketingButton } from '@/features/marketing/kit/marketing-button';
import { Band, Block, CellGrid, Heading, KeyRows, PageFrame, PageHero } from '@/features/marketing/kit/page-frame';
import { cn } from '@kortix/ui';
import { CheckIcon, LinkSimpleIcon, MinusIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

import { CONTROL, REACH, REACH_COLUMNS, SESSION_FACTS, SHARE_OPTIONS, SHARED, SURFACES } from './content';

// Facts and their sources: the header of ./content.ts.

function Actions() {
  return (
    <>
      <MarketingButton size="md" className="hit-area-y-1" asChild>
        <Link href="/auth">Start for free</Link>
      </MarketingButton>
      <MarketingButton variant="secondary" size="md" className="hit-area-y-1" asChild>
        <Link href="/docs/guide#teams">Read the Teams guide</Link>
      </MarketingButton>
    </>
  );
}

/** A session's access, as the Guide's "Share a session" lists it. Sample data is fictional. */
function SharePanel() {
  const selected = 'restricted';
  return (
    <figure className="bg-card flex justify-center px-4 py-8 lg:p-12" aria-label="Who can open a session">
      <div className="bg-background flex w-full max-w-xl flex-col rounded-lg border">
        <header className="flex items-center justify-between gap-4 border-b p-5">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-foreground truncate text-base font-medium">Arcadia pricing review</p>
            <p className="text-muted-foreground text-sm">
              Owner: Member 1 · agent <code className="text-foreground font-mono text-xs">kortix</code>
            </p>
          </div>
          <span className="bg-muted text-foreground flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium">
            M1
          </span>
        </header>
        <ul className="flex flex-col divide-y">
          {SHARE_OPTIONS.map((option) => {
            const on = option.id === selected;
            return (
              <li key={option.id} className="flex items-start gap-3 p-5">
                <span
                  aria-hidden
                  className={cn(
                    'mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    on && 'border-foreground',
                  )}
                >
                  {on ? <span className="bg-foreground size-2 rounded-full" /> : null}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className={cn('text-foreground text-sm', on && 'font-medium')}>{option.k}</p>
                  <p className="text-muted-foreground text-sm">{option.v}</p>
                  {on ? (
                    <ul className="flex flex-wrap gap-2 pt-2">
                      {['Member 2', 'Member 3', 'Finance'].map((who) => (
                        <li key={who} className="bg-muted text-foreground rounded-md px-2.5 py-1 text-sm">
                          {who}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <footer className="text-muted-foreground flex items-center gap-2 border-t p-5 text-sm">
          <LinkSimpleIcon className="size-4 shrink-0" aria-hidden />
          Public link: read-only, no sign-in. Revoke it at any time.
        </footer>
      </div>
    </figure>
  );
}

/** Which session each resource reaches: personal ones only your private session. */
function ReachTable() {
  return (
    <figure className="bg-card px-4 py-8 lg:p-12" aria-label="Which sessions each resource reaches">
      <div className="bg-background overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th scope="col" className="text-muted-foreground p-4 text-left font-normal lg:p-5">
                Resource
              </th>
              {REACH_COLUMNS.map((col) => (
                <th key={col} scope="col" className="text-muted-foreground p-4 text-center font-normal lg:p-5">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {REACH.map((row) => (
              <tr key={row.id}>
                <th scope="row" className="text-foreground p-4 text-left font-medium lg:p-5">
                  {row.k}
                </th>
                {REACH_COLUMNS.map((col, i) => {
                  const reaches = i === 0 || !row.personal;
                  return (
                    <td key={col} className="p-4 text-center lg:p-5">
                      {reaches ? (
                        <CheckIcon className="text-foreground inline size-4" aria-label="Yes" />
                      ) : (
                        <MinusIcon className="text-muted-foreground inline size-4" aria-label="No" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="text-muted-foreground pt-4 text-sm">
        In every case, the agent also needs access to the connector or secret.
      </figcaption>
    </figure>
  );
}

export function MultiplayerPage() {
  return (
    <PageFrame>
      <PageHero
        title="Multiplayer AI."
        titleMuted="One AI for the whole team."
        sub="Everyone works with the same agents, skills, memory and connectors. Start a session in the web app, in Slack or in Microsoft Teams, and share it with the people who need it."
        actions={<Actions />}
      />

      <Block id="shared">
        <Heading
          title="Set it up once."
          titleMuted="The whole team uses it."
          sub="A project holds the agents, skills, folders and connectors. Every member works from the same project."
        />
        <Band className="mt-12">
          <CellGrid items={SHARED} cols="lg:grid-cols-4" />
        </Band>
      </Block>

      <Block id="everywhere">
        <Heading
          title="Work where you already are."
          titleMuted="Every surface reads the same projects and sessions."
        />
        <div className="mt-10">
          <KeyRows rows={SURFACES} />
        </div>
      </Block>

      <Block id="sessions">
        <Heading
          title="Sessions are shared."
          titleMuted="The owner decides who else can open them."
          sub="A session is private to the person who started it. The owner can open it to chosen people and groups, or to the whole project."
        />
        <Band className="mt-12">
          <SharePanel />
        </Band>
        <Band className="mt-12">
          <CellGrid items={SESSION_FACTS} cols="lg:grid-cols-4" />
        </Band>
      </Block>

      <Block id="control">
        <Heading title="People stay in charge." titleMuted="Roles decide who does what. Agents ask first where you set it." />
        <div className="mt-10">
          <KeyRows rows={CONTROL} />
        </div>
      </Block>

      <Block id="personal">
        <Heading
          title="Personal stays personal."
          titleMuted="Your accounts, secrets and folder reach only your private sessions."
          sub="A shared session or a scheduled run acts for nobody. It gets only what is shared with the project."
        />
        <Band className="mt-12">
          <ReachTable />
        </Band>
      </Block>

      <div className="pb-20 lg:pb-28">
        <Block id="start">
          <Heading
            title="Members are free."
            titleMuted="Invite the whole team."
            sub="Members are unlimited and free, and the account shares one credit pool."
            actions={<Actions />}
          />
        </Block>
      </div>
    </PageFrame>
  );
}

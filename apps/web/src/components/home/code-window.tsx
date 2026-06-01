'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { motion } from 'motion/react';
import { useState } from 'react';
import { AiOutlineCheck } from 'react-icons/ai';
import { HyperText } from '../ui/hyper-text';
import { Loader } from '../ui/loader';

type TabId = 'toml' | 'agent' | 'deploy';

const TABS: { id: TabId; label: string }[] = [
  { id: 'toml', label: 'kortix.toml' },
  { id: 'agent', label: 'support.md' },
  { id: 'deploy', label: 'deploy' },
];

const C = {
  c: 'text-muted-foreground/70', // comment / muted
  s: 'text-emerald-600 dark:text-emerald-400', // string / value
  f: 'text-foreground', // key / ident
};

function Line({
  children,
  className,
  variants,
}: {
  children: React.ReactNode;
  className?: string;
  variants?: typeof deployLine;
}) {
  const classes = cn('flex leading-relaxed', className);
  if (variants) {
    return (
      <motion.div variants={variants} className={classes}>
        {children}
      </motion.div>
    );
  }
  return <div className={classes}>{children}</div>;
}

function LineText({
  children,
  className,
  delay = 0,
}: {
  children: string;
  className?: string;
  delay?: number;
}) {
  return (
    <HyperText as="span" className={className} delay={delay} animateOnHover={false}>
      {children}
    </HyperText>
  );
}

Line.Text = LineText;

function Space() {
  return <span className="w-3">&nbsp;</span>;
}

const deployReveal = {
  hidden: {},
  visible: { transition: { staggerChildren: 2 } },
};

const deployLine = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.25 } },
};

function TomlBody() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <Line>
        <span className={C.c}>[project]</span>
      </Line>
      <Line>
        <span className={C.f}>name</span> ={' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line34JsxTextQuotAcmeAgiQuot')}
          </HyperText>
        </span>
      </Line>
      <Line>
        <Space />
      </Line>
      <Line>
        <span className={C.c}>[[triggers.cron]]</span>
      </Line>
      <Line>
        <span className={C.f}>agent</span> ={' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line37JsxTextQuotBriefingQuot')}
          </HyperText>
        </span>
      </Line>
      <Line>
        <span className={C.f}>schedule</span> ={' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line38JsxTextQuot08Quot')}
          </HyperText>
        </span>
      </Line>
      <Line>
        <Space />
      </Line>
      <Line>
        <span className={C.c}>[[channels]]</span>
      </Line>
      <Line>
        <span className={C.f}>type</span> ={' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line41JsxTextQuotSlackQuot')}
          </HyperText>
        </span>{' '}
        · <span className={C.f}>agent</span> ={' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line41JsxTextQuotSupportQuot')}
          </HyperText>
        </span>
      </Line>
      <Line>
        <Space />
      </Line>
      <Line>
        <span className={C.c}>[connectors]</span>
      </Line>
      <Line>
        <span className={C.f}>required</span> = [
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line44JsxTextQuotGmailQuot')}
          </HyperText>
        </span>
        ,{' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line44JsxTextQuotStripeQuot')}
          </HyperText>
        </span>
        ,{' '}
        <span className={C.s}>
          <HyperText>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line44JsxTextQuotSlackQuot')}
          </HyperText>
        </span>
        ]
      </Line>
    </>
  );
}

function AgentBody() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <>
      <Line>
        <span className={C.c}>
          {tHardcodedUi.raw('componentsHomeCodeWindow.line52JsxTextOpencodeAgentsSupportMd')}
        </span>
      </Line>
      <Line>
        <span className={C.c}>---</span>
      </Line>
      <Line>
        <span className={C.f}>name</span>:{' '}
        <span className={C.s}>
          <HyperText>support</HyperText>
        </span>
      </Line>
      <Line>
        <span className={C.f}>model</span>:{' '}
        <span className={C.s}>
          <HyperText>claude-opus-4-7</HyperText>
        </span>
      </Line>
      <Line>
        <span className={C.f}>skills</span>: [
        <span className={C.s}>
          <HyperText>refund-policy</HyperText>
        </span>
        ,{' '}
        <span className={C.s}>
          <HyperText>ticket-triage</HyperText>
        </span>
        ]
      </Line>
      <Line>
        <span className={C.f}>tools</span>: [
        <span className={C.s}>
          <HyperText>gmail</HyperText>
        </span>
        ,{' '}
        <span className={C.s}>
          <HyperText>stripe</HyperText>
        </span>
        ,{' '}
        <span className={C.s}>
          <HyperText>slack</HyperText>
        </span>
        ]
      </Line>
      <Line>
        <span className={C.c}>---</span>
      </Line>
      <Line>
        <Space />
      </Line>
      <Line>
        <span className={C.f}>
          {tHardcodedUi.raw(
            'componentsHomeCodeWindow.line60JsxTextYouAreTheSupportAgentForAcmeResolve',
          )}
        </span>
      </Line>
      <Line>
        <span className={C.f}>
          {tHardcodedUi.raw(
            'componentsHomeCodeWindow.line61JsxTextTicketsWithFullProductContextAndEscalate',
          )}
        </span>
      </Line>
      <Line>
        <span className={C.f}>
          {tHardcodedUi.raw(
            'componentsHomeCodeWindow.line62JsxTextAnythingOver500ForHumanApproval',
          )}
        </span>
      </Line>
    </>
  );
}

function DeployBody() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <motion.div initial="hidden" animate="visible" variants={deployReveal}>
      <Line variants={deployLine}>
        <Line.Text className={C.c}>
          {tHardcodedUi.raw('componentsHomeCodeWindow.line70JsxTextKortixDeploy')}
        </Line.Text>
      </Line>
      <Line variants={deployLine} className="items-center justify-start gap-2">
        <span className={C.s}>
          <AiOutlineCheck className="size-3" />
        </span>{' '}
        <Line.Text className={C.f} delay={1000}>
          {tHardcodedUi.raw('componentsHomeCodeWindow.line71JsxTextPushedToMain')}
        </Line.Text>
      </Line>
      <Line variants={deployLine} className="items-center justify-start gap-2">
        <span className={C.s}>
          <AiOutlineCheck className="size-3" />
        </span>{' '}
        <Line.Text className={C.f} delay={1000}>
          {tHardcodedUi.raw('componentsHomeCodeWindow.line72JsxTextSandboxSnapshotBooted')}
        </Line.Text>
      </Line>
      <Line variants={deployLine} className="items-center justify-start gap-2">
        <span className={C.s}>
          <AiOutlineCheck className="size-3" />
        </span>{' '}
        <Line.Text className={C.f} delay={1000}>
          {tHardcodedUi.raw('componentsHomeCodeWindow.line73JsxTextTriggersScheduledChannelsLive')}
        </Line.Text>
      </Line>
      <Line variants={deployLine} className="items-center justify-start gap-2">
        <Space />
      </Line>
      <Line variants={deployLine} className="items-center justify-start gap-2">
        <span className="text-foreground inline-flex items-center gap-2">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          <Line.Text delay={1000}>
            {tHardcodedUi.raw('componentsHomeCodeWindow.line75JsxTextAcmeAgiIsRunning247')}
          </Line.Text>
        </span>
      </Line>
      <Line variants={deployLine} className="items-center justify-start gap-2">
        <Loader variant="terminal" />
      </Line>
    </motion.div>
  );
}

export function CodeWindow({ className }: { className?: string }) {
  const [tab, setTab] = useState<TabId>('toml');
  return (
    <div
      className={cn('border-border bg-card overflow-hidden rounded border shadow-xl', className)}
    >
      <div className="border-border bg-card flex items-center gap-1 border-b p-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded px-3 py-1.5 text-left text-sm font-medium transition-colors',
              tab === t.id
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-[260px] px-5 py-4 font-mono text-sm">
        {tab === 'toml' && <TomlBody />}
        {tab === 'agent' && <AgentBody />}
        {tab === 'deploy' && <DeployBody />}
      </div>
    </div>
  );
}

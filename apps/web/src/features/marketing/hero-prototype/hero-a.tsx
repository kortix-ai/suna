'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KortixLogo } from '@/components/ui/kortix-logo';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@/components/ui/modal';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/features/providers/auth-provider';
import { latestProjectPath } from '@/lib/onboarding/last-project-cookie';
import { cn } from '@/lib/utils';
import {
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowsOutSimpleIcon,
  CheckIcon,
  CodeIcon,
  DesktopIcon,
  DeviceMobileIcon,
  FileTextIcon,
  GlobeIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import { OrbitPage } from './orbit-page';
import './prototype.css';

type Stage = 'brief' | 'build' | 'preview';
type Source = 'launch-brief.md' | 'brand-guide.md';
const sources: Record<Source, { title: string; sections: { label: string; text: string }[] }> = {
  'launch-brief.md': {
    title: 'Orbit · launch brief',
    sections: [
      {
        label: 'Who it’s for',
        text: 'Small teams that want shared priorities without another status meeting.',
      },
      {
        label: 'What to say',
        text: 'One place for projects, clear ownership, and updates that keep everyone in sync.',
      },
      {
        label: 'What to build',
        text: 'A headline, product introduction, a Get started action, a task preview, and three benefits.',
      },
    ],
  },
  'brand-guide.md': {
    title: 'Orbit · brand guide',
    sections: [
      { label: 'Identity', text: 'A compact orbit wordmark with a simple geometric symbol.' },
      {
        label: 'Typography & color',
        text: 'Clear sans-serif type. Neutral surfaces, strong text contrast, and restrained borders.',
      },
      {
        label: 'Voice & controls',
        text: 'Calm and direct. Short labels, generous touch targets, and one primary action.',
      },
    ],
  },
};
const steps = [
  {
    title: 'Read the brief and brand guide',
    detail: '2 files · audience, content, and visual direction',
    icon: FileTextIcon,
  },
  {
    title: 'Build the page structure and content',
    detail: 'Hero, product preview, and three benefits',
    icon: CodeIcon,
  },
  {
    title: 'Prepare desktop and phone previews',
    detail: 'Responsive page ready to explore',
    icon: GlobeIcon,
  },
];

/** Throwaway Hero A: does one readable task explain Kortix at first glance? */
export default function HeroA() {
  const { user } = useAuth();
  const [stage, setStage] = useState<Stage>('preview');
  const [source, setSource] = useState<Source | null>(null);
  const [pane, setPane] = useState('preview');
  const [device, setDevice] = useState('desktop');
  const [expanded, setExpanded] = useState(false);
  const [signedUp, setSignedUp] = useState(false);
  const showcaseRef = useRef<HTMLDivElement>(null);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const sourceClose = useRef<HTMLButtonElement>(null);

  const closeSource = () => {
    setSource(null);
    sourceTrigger.current?.focus();
  };
  const selectStage = (value: string) => {
    setStage(value as Stage);
    setSource(null);
  };
  const walkthrough = () => {
    setStage('brief');
    setSource(null);
    setPane('task');
    showcaseRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    showcaseRef.current?.focus({ preventScroll: true });
  };
  const reset = () => {
    setStage('preview');
    setSource(null);
    setPane('preview');
    setDevice('desktop');
    setSignedUp(false);
  };
  const artifact = <OrbitPage signedUp={signedUp} onSignup={() => setSignedUp(true)} />;

  return (
    <section
      id="hero"
      aria-label="Kortix interactive product hero"
      className="hero-prototype bg-background text-foreground pt-24 pb-12 sm:pb-16"
    >
      <div className="mx-auto w-full max-w-7xl px-6 pt-10 sm:pt-16">
        <div className="grid gap-6 lg:grid-cols-12 lg:items-end lg:gap-12">
          <div className="lg:col-span-7">
            <p className="text-muted-foreground mb-5 flex items-center gap-2 text-sm">
              <span className="bg-foreground size-1.5 rounded-full" aria-hidden />
              Open-source AI workspace
            </p>
            <h1 className="text-4xl leading-tight font-medium tracking-tight sm:text-5xl lg:text-6xl">
              Your AI agents.
              <br />
              One workspace.
            </h1>
          </div>
          <div className="flex flex-col gap-6 lg:col-span-5 lg:pb-1">
            <p className="text-muted-foreground max-w-md text-base leading-relaxed lg:text-lg">
              Give agents your tools, files, and company context to research, build, and automate
              work.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                asChild
                className="h-12 px-5 active:scale-[0.96] motion-reduce:transform-none"
              >
                <a href={user ? latestProjectPath(user.id) : '/auth'}>
                  Get started
                  <ArrowRightIcon className="size-4" />
                </a>
              </Button>
              <Button
                variant="outline"
                onClick={walkthrough}
                className="h-12 px-5 active:scale-[0.96] motion-reduce:transform-none"
              >
                See how it works
                <ArrowDownIcon className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-10 sm:mt-12">
          <div className="text-muted-foreground mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <p>
              Example task: <span className="text-foreground">Build a launch page</span>
            </p>
            <span className="hidden sm:inline">Your context. An agent. Something you can use.</span>
          </div>
          <div
            id="demo"
            ref={showcaseRef}
            tabIndex={-1}
            className="bg-popover focus-visible:ring-ring scroll-mt-24 overflow-hidden rounded-xl border outline-none focus-visible:ring-2"
          >
            <div className="flex items-center justify-between gap-3 border-b px-4 py-2 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <KortixLogo variant="icon" size={20} />
                <span className="text-muted-foreground" aria-hidden>
                  /
                </span>
                <span className="truncate text-sm font-medium">Orbit launch</span>
                <Badge size="sm" variant="outline">
                  Example
                </Badge>
              </div>
              <Modal open={expanded} onOpenChange={setExpanded}>
                <ModalTrigger asChild>
                  <Button variant="ghost" className="size-12 shrink-0" aria-label="Expand preview">
                    <ArrowsOutSimpleIcon className="size-4" />
                  </Button>
                </ModalTrigger>
                <ModalContent
                  variant="base"
                  animation="none"
                  className="max-h-dvh gap-0 space-y-0 lg:max-w-4xl"
                  closeClassName="size-12"
                  closeLabel="Close expanded preview"
                >
                  <ModalHeader className="shrink-0 border-b pr-16">
                    <ModalTitle>Orbit launch page</ModalTitle>
                    <ModalDescription>
                      Interactive example · no account or deployment is created.
                    </ModalDescription>
                  </ModalHeader>
                  <ModalBody className="overflow-y-auto p-0">{artifact}</ModalBody>
                </ModalContent>
              </Modal>
            </div>
            <Tabs value={pane} onValueChange={setPane} className="border-b sm:hidden">
              <TabsList
                aria-label="Showcase pane"
                className="grid h-auto w-full grid-cols-2 rounded-none bg-transparent p-0"
              >
                <TabsTrigger
                  value="task"
                  aria-controls="hero-task-pane"
                  className="h-12 rounded-none"
                >
                  Task
                </TabsTrigger>
                <TabsTrigger
                  value="preview"
                  aria-controls="hero-preview-pane"
                  className="h-12 rounded-none"
                >
                  Preview
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="grid lg:grid-cols-12">
              <div
                id="hero-task-pane"
                role="tabpanel"
                aria-label="Task"
                className={cn(
                  'min-w-0 flex-col border-b lg:col-span-5 lg:border-r lg:border-b-0',
                  pane === 'task' ? 'flex' : 'hidden sm:flex',
                )}
              >
                <div className="flex items-center justify-between border-b px-4 sm:px-6">
                  <Tabs value={stage} onValueChange={selectStage}>
                    <TabsList
                      type="underline"
                      aria-label="Task walkthrough"
                      className="h-auto border-0 bg-transparent"
                    >
                      {(['brief', 'build', 'preview'] as const).map((key, i) => (
                        <TabsTrigger
                          key={key}
                          value={key}
                          id={`hero-stage-${key}`}
                          aria-controls="hero-stage-detail"
                          className="h-12 gap-2 rounded-none px-3 text-xs"
                        >
                          <span className="text-muted-foreground">0{i + 1}</span>
                          {key === 'brief' ? 'Brief' : key === 'build' ? 'Build' : 'Preview'}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                  <Button
                    variant="ghost"
                    aria-label="Reset example"
                    onClick={reset}
                    className="size-12"
                  >
                    <ArrowCounterClockwiseIcon className="size-4" />
                  </Button>
                </div>
                <div className="flex flex-1 flex-col gap-6 p-5 sm:p-6">
                  <div>
                    <div className="mb-3 flex items-center gap-2">
                      <span
                        className="bg-secondary flex size-6 items-center justify-center rounded-full text-xs"
                        aria-hidden
                      >
                        Y
                      </span>
                      <span className="text-xs font-medium">You</span>
                    </div>
                    <p className="text-sm leading-relaxed">
                      Build a launch page for Orbit using the attached brief and brand guide.
                      Include the product benefits and a clear signup action.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {(Object.keys(sources) as Source[]).map((name) => (
                        <Button
                          key={name}
                          variant="outline"
                          className="h-12 gap-2 px-3 font-mono text-xs"
                          aria-expanded={source === name}
                          aria-controls="hero-stage-detail"
                          onClick={(event) => {
                            sourceTrigger.current = event.currentTarget;
                            setSource(name);
                            requestAnimationFrame(() => sourceClose.current?.focus());
                          }}
                        >
                          <FileTextIcon className="text-muted-foreground size-4" />
                          {name}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <KortixLogo variant="icon" size={18} />
                    <span className="text-xs font-medium">Kortix</span>
                    <span className="text-muted-foreground text-xs">
                      /{' '}
                      {source
                        ? 'Source file'
                        : stage === 'preview'
                          ? 'Ready for review'
                          : stage === 'brief'
                            ? 'Understanding the task'
                            : 'Building the page'}
                    </span>
                  </div>
                  <div
                    id="hero-stage-detail"
                    role="tabpanel"
                    aria-labelledby={`hero-stage-${stage}`}
                    tabIndex={0}
                    key={source ?? stage}
                    className="hero-prototype-change"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && source) {
                        event.stopPropagation();
                        closeSource();
                      }
                    }}
                  >
                    {source ? (
                      <div className="border-t pt-4">
                        <div className="mb-4 flex items-center justify-between gap-3">
                          <h2 className="text-sm font-medium">{sources[source].title}</h2>
                          <Button
                            ref={sourceClose}
                            variant="ghost"
                            className="size-12"
                            aria-label="Close source file"
                            onClick={closeSource}
                          >
                            <XIcon className="size-4" />
                          </Button>
                        </div>
                        <dl className="space-y-4">
                          {sources[source].sections.map((section) => (
                            <div key={section.label}>
                              <dt className="text-xs font-medium">{section.label}</dt>
                              <dd className="text-muted-foreground mt-1.5 text-sm leading-relaxed">
                                {section.text}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ) : stage === 'brief' ? (
                      <div className="space-y-5">
                        <p className="text-sm leading-relaxed">
                          I’ll use your brief for the page structure and your brand guide for the
                          visual direction.
                        </p>
                        <dl className="space-y-4 border-l pl-4">
                          <div>
                            <dt className="text-xs font-medium">Audience</dt>
                            <dd className="text-muted-foreground mt-1.5 text-sm">
                              Small teams that want a calmer way to work.
                            </dd>
                          </div>
                          <div>
                            <dt className="text-xs font-medium">Deliverable</dt>
                            <dd className="text-muted-foreground mt-1.5 text-sm">
                              A responsive launch page with a product preview and signup action.
                            </dd>
                          </div>
                        </dl>
                        <Button
                          variant="outline"
                          onClick={() => selectStage('build')}
                          className="h-12"
                        >
                          See the build
                          <ArrowRightIcon className="size-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="space-y-6">
                        <ol className="space-y-5">
                          {steps.map(({ title, detail, icon: Icon }) => (
                            <li key={title} className="flex gap-3">
                              <Icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium">{title}</p>
                                <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                                  {detail}
                                </p>
                              </div>
                              <CheckIcon
                                className="text-kortix-green size-3.5 shrink-0"
                                aria-label="Complete"
                              />
                            </li>
                          ))}
                        </ol>
                        {stage === 'build' ? (
                          <div className="space-y-4">
                            <p className="text-muted-foreground border-t pt-4 text-sm leading-relaxed">
                              The page brings your message, product UI, and next step into one
                              responsive layout.
                            </p>
                            <Button
                              variant="outline"
                              className="h-12"
                              onClick={() => {
                                selectStage('preview');
                                setPane('preview');
                              }}
                            >
                              View the result
                              <ArrowRightIcon className="size-4" />
                            </Button>
                          </div>
                        ) : (
                          <div className="border-t pt-5">
                            <p className="text-sm leading-relaxed">
                              Your launch page is ready. Explore the preview, or switch to the phone
                              layout.
                            </p>
                            <div className="mt-4 flex items-center gap-3">
                              <GlobeIcon className="text-muted-foreground size-4" />
                              <span className="font-mono text-xs">orbit-launch</span>
                              <Badge variant="outline" size="sm">
                                Ready
                              </Badge>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-auto pt-5 text-xs">
                    Example task · explore each step
                  </p>
                </div>
              </div>
              <div
                id="hero-preview-pane"
                role="tabpanel"
                aria-label="Preview"
                className={cn(
                  'bg-card min-w-0 flex-col lg:col-span-7',
                  pane === 'preview' ? 'flex' : 'hidden sm:flex',
                )}
              >
                <div className="flex items-center justify-between gap-2 border-b px-4 sm:px-6">
                  <span className="flex items-center gap-2 text-xs">
                    <GlobeIcon className="text-muted-foreground size-4" />
                    Preview
                  </span>
                  <Tabs value={device} onValueChange={setDevice}>
                    <TabsList
                      aria-label="Preview device"
                      className="h-auto rounded-none bg-transparent p-0"
                    >
                      <TabsTrigger
                        value="desktop"
                        className="h-12 rounded-none px-3"
                        id="hero-device-desktop"
                        aria-controls="hero-artifact"
                        aria-label="Desktop preview"
                      >
                        <DesktopIcon className="size-4" />
                        <span className="hidden text-xs sm:inline">Desktop</span>
                      </TabsTrigger>
                      <TabsTrigger
                        value="phone"
                        className="h-12 rounded-none px-3"
                        id="hero-device-phone"
                        aria-controls="hero-artifact"
                        aria-label="Phone preview"
                      >
                        <DeviceMobileIcon className="size-4" />
                        <span className="hidden text-xs sm:inline">Phone</span>
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                <div className="flex flex-1 items-start justify-center p-3 sm:p-5">
                  <div
                    key={device}
                    id="hero-artifact"
                    role="tabpanel"
                    aria-labelledby={`hero-device-${device}`}
                    data-preview-device={device}
                    className={cn(
                      'hero-prototype-change bg-background w-full overflow-hidden border',
                      device === 'phone' && 'max-w-xs',
                    )}
                  >
                    {artifact}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p className="text-muted-foreground mt-4 text-center text-xs">
            One example of what you can build with Kortix.
          </p>
        </div>
      </div>
    </section>
  );
}

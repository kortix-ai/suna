'use client';

import SiteLink from '@/components/site-link';
import { useCopy } from '@/hooks/use-copy';
import { cn } from '@/lib/utils';
import {
  ArrowRightIcon,
  CheckIcon,
  MagnifyingGlassIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { CLI_REFERENCE_URL, type CliGroup } from './content';
import { useDevelopersCopy } from './use-developers-copy';
import { DitherField, TwoToneHeading } from './shared';

const PREFIX = 'kortix ';
const QUERIES = [
  'kortix s',
  'kortix con',
  'kortix tr',
  'kortix ch',
  'kortix i',
  'kortix f',
] as const;
const TYPE_MS = 60;
const HOLD_MS = 2200;
const ERASE_MS = 25;
const BLUR_RESUME_MS = 1500;
const IDLE_RESUME_MS = 8000;

/** Matches on the text after `kortix `: prefix matches first, substring only when none. */
function filterGroups(groups: readonly CliGroup[], value: string) {
  const v = value.trim().toLowerCase();
  const q = 'kortix'.startsWith(v) ? '' : v.replace(/^kortix\s*/, '');
  const run = (test: (name: string) => boolean) =>
    groups
      .map((g) => ({ ...g, cmds: g.cmds.filter(([c]) => test(c.slice('kortix '.length))) }))
      .filter((g) => g.cmds.length > 0);
  const prefix = run((n) => n.startsWith(q));
  return prefix.length > 0 || q === '' ? prefix : run((n) => n.includes(q));
}

export function DevelopersCli() {
  const { cli } = useDevelopersCopy();
  const reduce = useReducedMotion();
  const paletteRef = useRef<HTMLDivElement>(null);
  const inView = useInView(paletteRef, { amount: 'some' });
  // `paused` stops the demo while the user is in control. It resumes on its own:
  // after the user goes idle or leaves the input.
  const [paused, setPaused] = useState(false);
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const resumeIn = (ms: number) => {
    clearTimeout(resumeTimer.current);
    resumeTimer.current = setTimeout(() => setPaused(false), ms);
  };
  const listRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{ cmd: string; ok: boolean } | null>(null);
  const { copy } = useCopy({ toast: false });
  const resultTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // While in view: type a query, hold, erase it fast, then type a random different one.
  // Pauses while the user is in control (see `paused`). Reduced motion shows one query.
  useEffect(() => {
    if (!inView || paused) return;
    if (reduce) {
      setValue(QUERIES[0]);
      return;
    }
    let q = 0;
    let i = PREFIX.length;
    let erasing = false;
    let timer: ReturnType<typeof setTimeout>;
    const nextQuery = () => {
      let n = q;
      while (n === q) n = Math.floor(Math.random() * QUERIES.length);
      return n;
    };
    const tick = () => {
      const query = QUERIES[q];
      if (!erasing) {
        i += 1;
        setValue(query.slice(0, i));
        if (i < query.length) timer = setTimeout(tick, TYPE_MS);
        else {
          erasing = true;
          timer = setTimeout(tick, HOLD_MS);
        }
      } else {
        i -= 1;
        setValue(query.slice(0, i));
        if (i > PREFIX.length) timer = setTimeout(tick, ERASE_MS);
        else {
          erasing = false;
          q = nextQuery();
          timer = setTimeout(tick, TYPE_MS * 4);
        }
      }
    };
    timer = setTimeout(tick, TYPE_MS);
    return () => clearTimeout(timer);
  }, [inView, reduce, paused]);

  const groups = filterGroups(cli.groups, value);
  const flat = groups.flatMap((g) => g.cmds.map(([c]) => c));
  const asPrompt = value
    .replace(/^\s*kortix\s*/i, '')
    .trim()
    .replace(/"/g, '\\"');
  const promptCmd = `kortix chat --prompt "${asPrompt}"`;
  const activeIndex = Math.min(active, Math.max(flat.length - 1, 0));

  const pick = async (cmd: string) => {
    const ok = await copy(cmd);
    setResult({ cmd, ok });
    clearTimeout(resultTimer.current);
    resultTimer.current = setTimeout(() => setResult(null), 1500);
  };

  useEffect(
    () => () => {
      clearTimeout(resultTimer.current);
      clearTimeout(resumeTimer.current);
    },
    [],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      if (!flat.length) return;
      const next = (activeIndex + step + flat.length) % flat.length;
      setActive(next);
      // Scroll the list itself (never the page) so the active option stays visible.
      const list = listRef.current;
      const opt = document.getElementById(`cli-opt-${next}`);
      if (list && opt) {
        const top =
          opt.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + opt.offsetHeight > list.scrollTop + list.clientHeight)
          list.scrollTop = top + opt.offsetHeight - list.clientHeight;
      }
    } else if (e.key === 'Enter') {
      if (flat[activeIndex]) pick(flat[activeIndex]);
      else if (asPrompt) pick(promptCmd);
    } else if (e.key === 'Escape') {
      setValue('');
      setActive(0);
    }
  };

  let optionIndex = -1;
  return (
    <section id="cli" className="relative w-full overflow-clip">
      {/* Decorative: behind the palette, fades out into the page background. */}
      <DitherField className="inset-x-0 top-auto bottom-0 h-4/5 mask-[radial-gradient(ellipse_at_center,black_30%,transparent_70%)] opacity-25" />
      <div className="relative mx-auto flex max-w-7xl flex-col items-center px-6 py-24 text-center md:py-30">
        <TwoToneHeading lines={cli.headline} />

        <div
          ref={paletteRef}
          className="smooth-shadow-ring bg-card mt-14 w-full max-w-3xl overflow-hidden rounded-2xl text-left"
        >
          <div className="border-border flex items-center gap-3 border-b px-5 py-4">
            <MagnifyingGlassIcon aria-hidden className="text-muted-foreground size-4.5 shrink-0" />
            <input
              type="text"
              value={value}
              role="combobox"
              aria-label={cli.filterLabel}
              aria-expanded
              aria-autocomplete="list"
              aria-controls="cli-listbox"
              aria-activedescendant={flat.length ? `cli-opt-${activeIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder={QUERIES[0]}
              onFocus={() => {
                setPaused(true);
                resumeIn(IDLE_RESUME_MS);
              }}
              onBlur={() => resumeIn(BLUR_RESUME_MS)}
              onChange={(e) => {
                const next = e.target.value;
                setPaused(true);
                setValue(next);
                resumeIn(IDLE_RESUME_MS);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent font-mono text-base tracking-normal outline-none"
            />
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {cli.matches(flat.length)}
            </span>
          </div>

          <div
            id="cli-listbox"
            ref={listRef}
            role="listbox"
            aria-label={cli.listLabel}
            className="h-96 overflow-y-auto p-2"
          >
            {groups.map((g) => (
              <div key={g.label} role="group" aria-label={g.label} className="pb-1">
                <p aria-hidden className="text-muted-foreground px-3 pt-3 pb-1 text-xs font-medium">
                  {g.label}
                </p>
                {g.cmds.map(([cmd, desc]) => {
                  const i = ++optionIndex;
                  const isActive = i === activeIndex;
                  return (
                    <button
                      key={cmd}
                      id={`cli-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(cmd)}
                      className={cn(
                        'flex h-11 w-full cursor-pointer items-center gap-4 rounded-lg px-3 text-left transition-colors',
                        isActive && 'bg-muted',
                      )}
                    >
                      <span className="text-foreground w-44 shrink-0 font-mono text-sm font-medium tracking-normal">
                        {cmd}
                      </span>
                      <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">
                        {desc}
                      </span>
                      {/* Copied: check + label in ink for 1.5s. Status text, not a toast. */}
                      {result?.cmd === cmd && (
                        <span className="text-foreground flex shrink-0 items-center gap-1.5 text-xs font-medium">
                          {result.ok && <CheckIcon weight="bold" className="size-3.5" />}
                          {result.ok ? cli.copied : cli.copyFailed}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && (
              // Not a command: offer it as a prompt to the session agent instead.
              <div className="flex flex-col gap-2 px-3 pt-3">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(promptCmd)}
                  className="bg-muted flex h-11 w-full cursor-pointer items-center gap-4 rounded-lg px-3 text-left"
                >
                  <span className="text-foreground min-w-0 flex-1 truncate font-mono text-sm font-medium tracking-normal">
                    {promptCmd}
                  </span>
                  {result?.cmd === promptCmd ? (
                    <span className="text-foreground flex shrink-0 items-center gap-1.5 text-xs font-medium">
                      {result.ok && <CheckIcon weight="bold" className="size-3.5" />}
                      {result.ok ? cli.copied : cli.copyFailed}
                    </span>
                  ) : (
                    <span className="text-muted-foreground shrink-0 text-xs">{cli.promptHint}</span>
                  )}
                </button>
              </div>
            )}
          </div>

          <div className="border-border text-muted-foreground flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t px-5 py-3 text-xs">
            <span className="flex items-center gap-1.5">
              <TerminalWindowIcon aria-hidden className="size-3.5" />
              {cli.footerNote}
            </span>
            <SiteLink
              href={CLI_REFERENCE_URL}
              className="text-foreground flex items-center gap-1 font-medium transition-opacity hover:opacity-70"
            >
              {cli.referenceCta}
              <ArrowRightIcon className="size-3" />
            </SiteLink>
          </div>
          <span role="status" className="sr-only">
            {result
              ? result.ok
                ? cli.copiedCmd(result.cmd)
                : cli.copyFailed
              : cli.matches(flat.length)}
          </span>
        </div>

        <p className="text-muted-foreground mt-10 max-w-xl text-balance">{cli.note}</p>
      </div>
    </section>
  );
}
